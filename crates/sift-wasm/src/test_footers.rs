//! Hand-built Parquet footers for tests. They are serialized straight from
//! thrift, so their statistics can say what no writer would.

/// Keep valid row-group bytes/counts, but replace the declared global total.
pub(crate) fn parquet_with_footer_total(
    batch: &arrow::record_batch::RecordBatch,
    row_group_size: usize,
    rows: i64,
) -> Vec<u8> {
    use parquet::file::metadata::ParquetMetaDataReader;
    use parquet::file::FOOTER_SIZE;
    use parquet::thrift::{TCompactOutputProtocol, TSerializable};
    let properties = parquet::file::properties::WriterProperties::builder()
        .set_max_row_group_size(row_group_size)
        .build();
    let mut file = Vec::new();
    let mut writer =
        parquet::arrow::ArrowWriter::try_new(&mut file, batch.schema(), Some(properties)).unwrap();
    writer.write(batch).unwrap();
    let mut metadata = writer.close().unwrap();
    let footer = ParquetMetaDataReader::decode_footer_tail(
        file[file.len() - FOOTER_SIZE..].try_into().unwrap(),
    )
    .unwrap();
    let footer_start = file.len() - FOOTER_SIZE - footer.metadata_length();
    file.truncate(footer_start);
    metadata.num_rows = rows;
    metadata
        .write_to_out_protocol(&mut TCompactOutputProtocol::new(&mut file))
        .unwrap();
    let metadata_len = (file.len() - footer_start) as u32;
    file.extend_from_slice(&metadata_len.to_le_bytes());
    file.extend_from_slice(b"PAR1");
    file
}

/// A footer with one optional INT96 column whose `min_value` statistic is
/// `min_length` bytes, serialized straight from thrift so the length can
/// be wrong. Returns the tail and a file length that fits its one chunk.
pub(crate) fn int96_footer(min_length: usize) -> (Vec<u8>, u64) {
    let statistics = parquet::format::Statistics::new(
        None,
        None,
        0,
        None,
        vec![0xAB; 12],
        vec![0xCD; min_length],
        None,
        None,
    );
    thrift_footer(parquet::format::Type::INT96, statistics)
}

/// A one-column, one-row footer written straight from thrift, so its
/// statistics can say what no writer would.
pub(crate) fn thrift_footer(
    physical: parquet::format::Type,
    statistics: parquet::format::Statistics,
) -> (Vec<u8>, u64) {
    use parquet::format::{FieldRepetitionType, SchemaElement};
    let root = SchemaElement::new(
        None,
        None,
        None,
        "schema".to_string(),
        1,
        None,
        None,
        None,
        None,
        None,
    );
    let leaf = SchemaElement::new(
        physical,
        None,
        FieldRepetitionType::OPTIONAL,
        "t".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
    );
    footer_with_schema(vec![root, leaf], &["t"], physical, statistics)
}

/// A one-row footer whose only column is `g.x`, a required INT32 inside the
/// group `g`, which has repetition `group_repetition`. Parquet requires one
/// on every non-root element; a footer without it is malformed.
pub(crate) fn group_footer(
    group_repetition: Option<parquet::format::FieldRepetitionType>,
) -> (Vec<u8>, u64) {
    use parquet::format::{FieldRepetitionType, SchemaElement, Statistics, Type};
    let element = |physical, repetition, name: &str, children| {
        SchemaElement::new(
            physical,
            None,
            repetition,
            name.to_string(),
            children,
            None,
            None,
            None,
            None,
            None,
        )
    };
    let schema = vec![
        element(None, None, "schema", Some(1)),
        element(None, group_repetition, "g", Some(1)),
        element(
            Some(Type::INT32),
            Some(FieldRepetitionType::REQUIRED),
            "x",
            None,
        ),
    ];
    let statistics = Statistics::new(None, None, 0, None, None, None, None, None);
    footer_with_schema(schema, &["g", "x"], Type::INT32, statistics)
}

/// A root annotation: a converted type, a logical type, or both.
pub(crate) type RootAnnotation = (
    Option<parquet::format::ConvertedType>,
    Option<parquet::format::LogicalType>,
);

/// Every root annotation Arrow's conversion sends to `visit_map` or
/// `visit_list`, as constructors.
pub(crate) const ROOT_MAP_OR_LIST_ANNOTATIONS: [fn() -> RootAnnotation; 5] = [
    || (Some(parquet::format::ConvertedType::LIST), None),
    || (Some(parquet::format::ConvertedType::MAP), None),
    || (Some(parquet::format::ConvertedType::MAP_KEY_VALUE), None),
    || {
        let list = parquet::format::ListType {};
        (None, Some(parquet::format::LogicalType::LIST(list)))
    },
    || {
        let map = parquet::format::MapType {};
        (None, Some(parquet::format::LogicalType::MAP(map)))
    },
];

/// A one-row footer whose root carries `annotation` over a repeated group
/// `g` holding a required INT32 `x`: the shape a list, or a map whose entry
/// has one field, takes. Parquet never gives the root a repetition.
pub(crate) fn annotated_root_footer(annotation: RootAnnotation) -> (Vec<u8>, u64) {
    use parquet::format::{FieldRepetitionType, SchemaElement, Statistics, Type};
    let (converted, logical) = annotation;
    let schema = vec![
        SchemaElement::new(
            None,
            None,
            None,
            "schema".to_string(),
            1,
            converted,
            None,
            None,
            None,
            logical,
        ),
        SchemaElement::new(
            None,
            None,
            FieldRepetitionType::REPEATED,
            "g".to_string(),
            1,
            None,
            None,
            None,
            None,
            None,
        ),
        SchemaElement::new(
            Type::INT32,
            None,
            FieldRepetitionType::REQUIRED,
            "x".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
        ),
    ];
    let statistics = Statistics::new(None, None, 0, None, None, None, None, None);
    footer_with_schema(schema, &["g", "x"], Type::INT32, statistics)
}

/// Serialize a one-row-group footer over `schema`, with one column chunk at
/// `path` of type `physical` carrying `statistics`. Returns the tail and a
/// file length that fits the chunk.
fn footer_with_schema(
    schema: Vec<parquet::format::SchemaElement>,
    path: &[&str],
    physical: parquet::format::Type,
    statistics: parquet::format::Statistics,
) -> (Vec<u8>, u64) {
    use parquet::format::{
        ColumnChunk, ColumnMetaData, CompressionCodec, Encoding, FileMetaData, RowGroup,
    };
    use parquet::thrift::{TCompactOutputProtocol, TSerializable};

    let meta = ColumnMetaData::new(
        physical,
        vec![Encoding::PLAIN],
        path.iter().map(|segment| segment.to_string()).collect(),
        CompressionCodec::UNCOMPRESSED,
        1,
        1,
        1,
        None,
        4,
        None,
        None,
        statistics,
        None,
        None,
        None,
        None,
    );
    let chunk = ColumnChunk::new(None, 4, meta, None, None, None, None, None, None);
    let group = RowGroup::new(vec![chunk], 1, 1, None, None, None, None);
    let metadata = FileMetaData::new(1, schema, 1, vec![group], None, None, None, None, None);
    let mut tail = Vec::new();
    {
        let mut protocol = TCompactOutputProtocol::new(&mut tail);
        metadata.write_to_out_protocol(&mut protocol).unwrap();
    }
    let metadata_len = tail.len() as u32;
    tail.extend_from_slice(&metadata_len.to_le_bytes());
    tail.extend_from_slice(b"PAR1");
    // Leading magic plus one byte of column data ahead of the footer.
    let file_len = tail.len() as u64 + 4 + 16;
    (tail, file_len)
}

/// A complete Parquet buffer around `int96_footer(min_length)`: leading magic,
/// four bytes of column data, then the footer, its length, and the magic.
pub(crate) fn int96_file(min_length: usize) -> Vec<u8> {
    let (tail, _) = int96_footer(min_length);
    let mut file = b"PAR1".to_vec();
    file.extend_from_slice(&[0; 4]);
    file.extend_from_slice(&tail);
    file
}
