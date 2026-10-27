//! Hand-built Parquet footers for tests. They are serialized straight from
//! thrift, so their statistics can say what no writer would.

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
