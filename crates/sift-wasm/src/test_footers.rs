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
    use parquet::format::{
        ColumnChunk, ColumnMetaData, CompressionCodec, Encoding, FieldRepetitionType, FileMetaData,
        RowGroup, SchemaElement,
    };
    use parquet::thrift::{TCompactOutputProtocol, TSerializable};

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
    let meta = ColumnMetaData::new(
        physical,
        vec![Encoding::PLAIN],
        vec!["t".to_string()],
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
    let metadata = FileMetaData::new(
        1,
        vec![root, leaf],
        1,
        vec![group],
        None,
        None,
        None,
        None,
        None,
    );
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
