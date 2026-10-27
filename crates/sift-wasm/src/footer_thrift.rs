//! Raw thrift pre-pass over a Parquet footer.
//!
//! `ParquetMetaDataReader::decode_metadata` (parquet 54.3.1) can abort the
//! module on a crafted footer: INT96 statistics longer than 12 bytes hit an
//! `assert_eq!`, and a known list with a negative or absurd length reaches
//! `Vec::with_capacity`. On wasm32 a panic aborts the instance. This module
//! reads the same bytes first and rejects those footers with an error.
//!
//! The parquet crate's compact input protocol is crate-private at 54.3.1, so
//! this is a small reader of its own. It mirrors the generated
//! `parquet::format` decoders byte for byte: a field the generated code knows
//! is read by its expected type whatever the wire type says, and any other
//! field is skipped by its wire type with the thrift crate's depth limit. That
//! keeps this reader positioned exactly where the real decoder is, so it sees
//! the statistics the real decoder will see. The field tables below follow
//! `parquet-54.3.1/src/format.rs`; a parquet upgrade that adds fields to these
//! structs must update them.
//!
//! The pre-pass also records what `decode_metadata` erases: whether each
//! column chunk's statistics carried a `null_count` at all. At 54.3.1 an
//! absent count decodes as `Some(0)`.

/// Thrift `Type::INT96`.
const THRIFT_INT96: i32 = 3;
/// The thrift crate's `MAXIMUM_SKIP_DEPTH`.
const MAX_SKIP_DEPTH: u8 = 64;
/// Longest varint a 64-bit value can need.
const MAX_VARINT_BYTES: usize = 10;

/// What the pre-pass keeps from a footer.
#[derive(Debug, Default)]
pub(crate) struct RawFooter {
    /// Thrift physical type of each schema leaf, in leaf order.
    pub(crate) leaf_types: Vec<Option<i32>>,
    /// Column chunks of each row group, in file order.
    pub(crate) row_groups: Vec<Vec<RawChunk>>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RawChunk {
    /// `ColumnMetaData.type`, when the chunk has metadata.
    pub(crate) physical_type: Option<i32>,
    pub(crate) statistics: Option<RawStatistics>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RawStatistics {
    pub(crate) null_count: Option<i64>,
    /// Byte lengths of `max`, `min`, `max_value`, `min_value`, when present.
    pub(crate) bound_lengths: [Option<usize>; 4],
}

impl RawFooter {
    /// Whether row group `group`'s chunk for `leaf` wrote a null count.
    pub(crate) fn null_count_present(&self, group: usize, leaf: usize) -> bool {
        self.row_groups
            .get(group)
            .and_then(|chunks| chunks.get(leaf))
            .and_then(|chunk| chunk.statistics.as_ref())
            .is_some_and(|stats| stats.null_count.is_some())
    }

    /// Reject INT96 statistics whose bounds are not 12 bytes. The chunk counts
    /// as INT96 when either its schema leaf or its own metadata says so.
    pub(crate) fn check_int96_statistics(&self) -> Result<(), String> {
        for chunks in &self.row_groups {
            for (leaf, chunk) in chunks.iter().enumerate() {
                let leaf_int96 = self.leaf_types.get(leaf).copied().flatten() == Some(THRIFT_INT96);
                if !leaf_int96 && chunk.physical_type != Some(THRIFT_INT96) {
                    continue;
                }
                let Some(stats) = &chunk.statistics else {
                    continue;
                };
                if stats
                    .bound_lengths
                    .iter()
                    .flatten()
                    .any(|length| *length != 12)
                {
                    return Err("Parquet footer has malformed INT96 statistics".to_string());
                }
            }
        }
        Ok(())
    }
}

/// Read a footer's `FileMetaData` thrift, rejecting what would trap the
/// parquet decoder.
pub(crate) fn read_raw_footer(buf: &[u8]) -> Result<RawFooter, String> {
    let mut reader = Reader {
        buf,
        pos: 0,
        pending_bool: None,
    };
    reader
        .file_metadata()
        .map_err(|e| format!("Could not parse Parquet footer: {e}"))
}

/// Locate the footer in a complete Parquet buffer and run the raw pre-pass.
/// Rejects bad magic, a footer length that does not fit, and anything
/// `read_raw_footer` / `check_int96_statistics` reject.
///
/// Every whole-buffer entry point calls this before handing the bytes to the
/// parquet crate, whose footer decoder can abort the module.
pub(crate) fn precheck_parquet_buffer(bytes: &[u8]) -> Result<RawFooter, String> {
    let len = bytes.len();
    if len < 12 {
        return Err("Parquet file is too small to hold a footer".to_string());
    }
    if &bytes[len - 4..] != b"PAR1" {
        return Err("Not a Parquet file: missing PAR1 footer magic".to_string());
    }
    let mut length = [0u8; 4];
    length.copy_from_slice(&bytes[len - 8..len - 4]);
    let metadata_len = u32::from_le_bytes(length) as usize;
    let footer_start = len
        .checked_sub(12)
        .and_then(|room| room.checked_sub(metadata_len))
        .map(|_| len - 8 - metadata_len)
        .ok_or("Parquet footer length exceeds the file length")?;
    let raw = read_raw_footer(&bytes[footer_start..len - 8])?;
    raw.check_int96_statistics()?;
    Ok(raw)
}

/// Compact protocol wire types.
mod wire {
    pub const STOP: u8 = 0x00;
    pub const BOOL: u8 = 0x01;
    pub const I8: u8 = 0x03;
    pub const I16: u8 = 0x04;
    pub const I32: u8 = 0x05;
    pub const I64: u8 = 0x06;
    pub const DOUBLE: u8 = 0x07;
    pub const BINARY: u8 = 0x08;
    pub const LIST: u8 = 0x09;
    pub const SET: u8 = 0x0A;
    pub const MAP: u8 = 0x0B;
    pub const STRUCT: u8 = 0x0C;
}

/// The type the generated decoder reads for a known field.
#[derive(Clone, Copy)]
enum Ty {
    Bool,
    I8,
    I16,
    I32,
    I64,
    Bytes,
    Str,
    List(&'static Ty),
    Struct(S),
}

/// Structs reachable from `FileMetaData`.
#[derive(Clone, Copy)]
enum S {
    /// Every struct with no fields (`StringType`, `TypeDefinedOrder`, ...).
    Empty,
    FileMetaData,
    SchemaElement,
    LogicalType,
    DecimalType,
    TimeUnit,
    /// `TimestampType` and `TimeType`.
    TimeLike,
    IntType,
    RowGroup,
    ColumnChunk,
    ColumnMetaData,
    Statistics,
    SizeStatistics,
    KeyValue,
    SortingColumn,
    PageEncodingStats,
    ColumnCryptoMetaData,
    EncryptionWithColumnKey,
    ColumnOrder,
    EncryptionAlgorithm,
    /// `AesGcmV1` and `AesGcmCtrV1`.
    Aes,
}

const LIST_I32: Ty = Ty::List(&Ty::I32);
const LIST_I64: Ty = Ty::List(&Ty::I64);
const LIST_STR: Ty = Ty::List(&Ty::Str);

/// Known fields per `parquet-54.3.1/src/format.rs`.
fn known_field(s: S, id: i16) -> Option<Ty> {
    use Ty::*;
    Some(match (s, id) {
        (S::FileMetaData, 1) => I32,
        (S::FileMetaData, 2) => List(&Struct(S::SchemaElement)),
        (S::FileMetaData, 3) => I64,
        (S::FileMetaData, 4) => List(&Struct(S::RowGroup)),
        (S::FileMetaData, 5) => List(&Struct(S::KeyValue)),
        (S::FileMetaData, 6) => Str,
        (S::FileMetaData, 7) => List(&Struct(S::ColumnOrder)),
        (S::FileMetaData, 8) => Struct(S::EncryptionAlgorithm),
        (S::FileMetaData, 9) => Bytes,
        (S::SchemaElement, 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9) => I32,
        (S::SchemaElement, 4) => Str,
        (S::SchemaElement, 10) => Struct(S::LogicalType),
        (S::LogicalType, 1 | 2 | 3 | 4 | 6 | 11 | 12 | 13 | 14 | 15) => Struct(S::Empty),
        (S::LogicalType, 5) => Struct(S::DecimalType),
        (S::LogicalType, 7 | 8) => Struct(S::TimeLike),
        (S::LogicalType, 10) => Struct(S::IntType),
        (S::DecimalType, 1 | 2) => I32,
        (S::TimeUnit, 1..=3) => Struct(S::Empty),
        (S::TimeLike, 1) => Bool,
        (S::TimeLike, 2) => Struct(S::TimeUnit),
        (S::IntType, 1) => I8,
        (S::IntType, 2) => Bool,
        (S::RowGroup, 1) => List(&Struct(S::ColumnChunk)),
        (S::RowGroup, 2 | 3 | 5 | 6) => I64,
        (S::RowGroup, 4) => List(&Struct(S::SortingColumn)),
        (S::RowGroup, 7) => I16,
        (S::ColumnChunk, 1) => Str,
        (S::ColumnChunk, 2 | 4 | 6) => I64,
        (S::ColumnChunk, 3) => Struct(S::ColumnMetaData),
        (S::ColumnChunk, 5 | 7) => I32,
        (S::ColumnChunk, 8) => Struct(S::ColumnCryptoMetaData),
        (S::ColumnChunk, 9) => Bytes,
        (S::ColumnMetaData, 1 | 4 | 15) => I32,
        (S::ColumnMetaData, 2) => LIST_I32,
        (S::ColumnMetaData, 3) => LIST_STR,
        (S::ColumnMetaData, 5 | 6 | 7 | 9 | 10 | 11 | 14) => I64,
        (S::ColumnMetaData, 8) => List(&Struct(S::KeyValue)),
        (S::ColumnMetaData, 12) => Struct(S::Statistics),
        (S::ColumnMetaData, 13) => List(&Struct(S::PageEncodingStats)),
        (S::ColumnMetaData, 16) => Struct(S::SizeStatistics),
        (S::Statistics, 1 | 2 | 5 | 6) => Bytes,
        (S::Statistics, 3 | 4) => I64,
        (S::Statistics, 7 | 8) => Bool,
        (S::SizeStatistics, 1) => I64,
        (S::SizeStatistics, 2 | 3) => LIST_I64,
        (S::KeyValue, 1 | 2) => Str,
        (S::SortingColumn, 1) => I32,
        (S::SortingColumn, 2 | 3) => Bool,
        (S::PageEncodingStats, 1..=3) => I32,
        (S::ColumnCryptoMetaData, 1) => Struct(S::Empty),
        (S::ColumnCryptoMetaData, 2) => Struct(S::EncryptionWithColumnKey),
        (S::EncryptionWithColumnKey, 1) => LIST_STR,
        (S::EncryptionWithColumnKey, 2) => Bytes,
        (S::ColumnOrder, 1) => Struct(S::Empty),
        (S::EncryptionAlgorithm, 1 | 2) => Struct(S::Aes),
        (S::Aes, 1 | 2) => Bytes,
        (S::Aes, 3) => Bool,
        _ => return None,
    })
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    /// A boolean field's value travels in its field header. Like the parquet
    /// protocol, it waits here for the next `read_bool`, even when the
    /// generated code reads that field as another type.
    pending_bool: Option<bool>,
}

type R<T> = Result<T, String>;

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    fn byte(&mut self) -> R<u8> {
        let byte = *self.buf.get(self.pos).ok_or("unexpected end of footer")?;
        self.pos += 1;
        Ok(byte)
    }

    fn take(&mut self, length: usize) -> R<&'a [u8]> {
        if length > self.remaining() {
            return Err("unexpected end of footer".to_string());
        }
        let bytes = &self.buf[self.pos..self.pos + length];
        self.pos += length;
        Ok(bytes)
    }

    fn varint(&mut self) -> R<u64> {
        let mut value = 0u64;
        for index in 0..MAX_VARINT_BYTES {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7F).wrapping_shl(7 * index as u32);
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("varint is too long".to_string())
    }

    fn zigzag(&mut self) -> R<i64> {
        let value = self.varint()?;
        Ok((value >> 1) as i64 ^ -((value & 1) as i64))
    }

    fn read_i16(&mut self) -> R<i16> {
        Ok(self.zigzag()? as i16)
    }

    fn read_i32(&mut self) -> R<i32> {
        Ok(self.zigzag()? as i32)
    }

    fn read_bytes(&mut self) -> R<&'a [u8]> {
        // `as usize` matches the parquet protocol, including on wasm32.
        let length = self.varint()? as usize;
        self.take(length)
    }

    fn read_str(&mut self) -> R<()> {
        let bytes = self.read_bytes()?;
        std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn read_bool(&mut self) -> R<bool> {
        if let Some(value) = self.pending_bool.take() {
            return Ok(value);
        }
        match self.byte()? {
            0x01 => Ok(true),
            0x00 | 0x02 => Ok(false),
            other => Err(format!("cannot convert {other} into bool")),
        }
    }

    fn wire_type(nibble: u8) -> R<u8> {
        match nibble {
            wire::STOP | wire::I8..=wire::STRUCT => Ok(nibble),
            other => Err(format!("cannot convert {other} into a thrift type")),
        }
    }

    /// The next field's `(id, wire type)`, or `None` at the struct's stop.
    fn field_begin(&mut self, last_id: &mut i16) -> R<Option<(i16, u8)>> {
        let header = self.byte()?;
        let delta = header >> 4;
        let field_type = match header & 0x0F {
            0x01 => {
                self.pending_bool = Some(true);
                wire::BOOL
            }
            0x02 => {
                self.pending_bool = Some(false);
                wire::BOOL
            }
            nibble => Self::wire_type(nibble)?,
        };
        if field_type == wire::STOP {
            return Ok(None);
        }
        *last_id = if delta != 0 {
            last_id
                .checked_add(i16::from(delta))
                .ok_or("field id overflows")?
        } else {
            self.read_i16()?
        };
        Ok(Some((*last_id, field_type)))
    }

    fn list_begin(&mut self) -> R<(u8, i32)> {
        let header = self.byte()?;
        let element_type = match header & 0x0F {
            0x01 | 0x02 => wire::BOOL,
            nibble => Self::wire_type(nibble)?,
        };
        let short_count = header >> 4;
        let count = if short_count != 15 {
            i32::from(short_count)
        } else {
            self.varint()? as i32
        };
        Ok((element_type, count))
    }

    /// Begin a list the generated code collects into a `Vec`. It reserves the
    /// declared length up front, so a negative length or one the remaining
    /// bytes cannot hold would trap; every element takes at least one byte.
    fn known_list_begin(&mut self) -> R<usize> {
        let (_, count) = self.list_begin()?;
        let count = usize::try_from(count).map_err(|_| "list length is negative")?;
        if count > self.remaining() {
            return Err(format!(
                "list claims {count} elements but only {} bytes remain",
                self.remaining()
            ));
        }
        Ok(count)
    }

    fn skip(&mut self, field_type: u8, depth: u8) -> R<()> {
        if depth == 0 {
            return Err("thrift nesting is too deep".to_string());
        }
        match field_type {
            wire::BOOL => self.read_bool().map(drop),
            wire::I8 => self.byte().map(drop),
            wire::I16 | wire::I32 | wire::I64 => self.zigzag().map(drop),
            wire::DOUBLE => self.take(8).map(drop),
            wire::BINARY => self.read_str(),
            wire::STRUCT => {
                let mut last_id = 0;
                while let Some((_, field_type)) = self.field_begin(&mut last_id)? {
                    self.skip(field_type, depth - 1)?;
                }
                Ok(())
            }
            wire::LIST => {
                let (element_type, count) = self.list_begin()?;
                for _ in 0..count {
                    self.skip(element_type, depth - 1)?;
                }
                Ok(())
            }
            wire::SET | wire::MAP => Err("thrift sets and maps are not supported".to_string()),
            other => Err(format!("cannot skip thrift type {other}")),
        }
    }

    /// Read a known field, or skip an unknown one, the way the generated
    /// decoder does.
    fn field(&mut self, s: S, id: i16, field_type: u8) -> R<()> {
        match known_field(s, id) {
            Some(ty) => self.expected(ty),
            None => self.skip(field_type, MAX_SKIP_DEPTH),
        }
    }

    fn expected(&mut self, ty: Ty) -> R<()> {
        match ty {
            Ty::Bool => self.read_bool().map(drop),
            Ty::I8 => self.byte().map(drop),
            Ty::I16 | Ty::I32 | Ty::I64 => self.zigzag().map(drop),
            Ty::Bytes => self.read_bytes().map(drop),
            Ty::Str => self.read_str(),
            Ty::List(element) => {
                for _ in 0..self.known_list_begin()? {
                    self.expected(*element)?;
                }
                Ok(())
            }
            Ty::Struct(s) => self.known_struct(s),
        }
    }

    fn known_struct(&mut self, s: S) -> R<()> {
        let mut last_id = 0;
        while let Some((id, field_type)) = self.field_begin(&mut last_id)? {
            self.field(s, id, field_type)?;
        }
        Ok(())
    }

    fn file_metadata(&mut self) -> R<RawFooter> {
        let mut footer = RawFooter::default();
        let mut last_id = 0;
        while let Some((id, field_type)) = self.field_begin(&mut last_id)? {
            match id {
                2 => {
                    let count = self.known_list_begin()?;
                    let mut elements = Vec::with_capacity(count);
                    for _ in 0..count {
                        elements.push(self.schema_element()?);
                    }
                    // Preorder: every non-root element without children is a
                    // leaf, as in parquet's `from_thrift_helper`.
                    footer.leaf_types = elements
                        .iter()
                        .skip(1)
                        .filter(|(_, children)| matches!(children, None | Some(0)))
                        .map(|(physical, _)| *physical)
                        .collect();
                }
                4 => {
                    let count = self.known_list_begin()?;
                    let mut groups = Vec::with_capacity(count);
                    for _ in 0..count {
                        groups.push(self.row_group()?);
                    }
                    footer.row_groups = groups;
                }
                _ => self.field(S::FileMetaData, id, field_type)?,
            }
        }
        Ok(footer)
    }

    /// `(type, num_children)` of one schema element.
    fn schema_element(&mut self) -> R<(Option<i32>, Option<i32>)> {
        let (mut physical, mut children) = (None, None);
        let mut last_id = 0;
        while let Some((id, field_type)) = self.field_begin(&mut last_id)? {
            match id {
                1 => physical = Some(self.read_i32()?),
                5 => children = Some(self.read_i32()?),
                _ => self.field(S::SchemaElement, id, field_type)?,
            }
        }
        Ok((physical, children))
    }

    fn row_group(&mut self) -> R<Vec<RawChunk>> {
        let mut chunks = Vec::new();
        let mut last_id = 0;
        while let Some((id, field_type)) = self.field_begin(&mut last_id)? {
            match id {
                1 => {
                    let count = self.known_list_begin()?;
                    let mut next = Vec::with_capacity(count);
                    for _ in 0..count {
                        next.push(self.column_chunk()?);
                    }
                    chunks = next;
                }
                _ => self.field(S::RowGroup, id, field_type)?,
            }
        }
        Ok(chunks)
    }

    fn column_chunk(&mut self) -> R<RawChunk> {
        let mut chunk = RawChunk::default();
        let mut last_id = 0;
        while let Some((id, field_type)) = self.field_begin(&mut last_id)? {
            match id {
                3 => chunk = self.column_metadata()?,
                _ => self.field(S::ColumnChunk, id, field_type)?,
            }
        }
        Ok(chunk)
    }

    fn column_metadata(&mut self) -> R<RawChunk> {
        let mut chunk = RawChunk::default();
        let mut last_id = 0;
        while let Some((id, field_type)) = self.field_begin(&mut last_id)? {
            match id {
                1 => chunk.physical_type = Some(self.read_i32()?),
                12 => chunk.statistics = Some(self.statistics()?),
                _ => self.field(S::ColumnMetaData, id, field_type)?,
            }
        }
        Ok(chunk)
    }

    fn statistics(&mut self) -> R<RawStatistics> {
        let mut stats = RawStatistics::default();
        let mut last_id = 0;
        while let Some((id, field_type)) = self.field_begin(&mut last_id)? {
            match id {
                1 => stats.bound_lengths[0] = Some(self.read_bytes()?.len()),
                2 => stats.bound_lengths[1] = Some(self.read_bytes()?.len()),
                3 => stats.null_count = Some(self.zigzag()?),
                5 => stats.bound_lengths[2] = Some(self.read_bytes()?.len()),
                6 => stats.bound_lengths[3] = Some(self.read_bytes()?.len()),
                _ => self.field(S::Statistics, id, field_type)?,
            }
        }
        Ok(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Footer bytes from a real writer, the way `open_parquet_file` sees them.
    fn footer_of(file: &[u8]) -> &[u8] {
        let n = file.len();
        let length = u32::from_le_bytes(file[n - 8..n - 4].try_into().unwrap()) as usize;
        &file[n - 8 - length..n - 8]
    }

    fn written_file() -> Vec<u8> {
        use arrow::array::{ArrayRef, Int64Array, StringArray};
        use arrow::record_batch::RecordBatch;
        use std::sync::Arc;
        let batch = RecordBatch::try_from_iter(vec![
            (
                "n",
                Arc::new(Int64Array::from(vec![Some(1), None, Some(3), Some(4)])) as ArrayRef,
            ),
            (
                "s",
                Arc::new(StringArray::from(vec![Some("a"), Some("b"), None, None])) as ArrayRef,
            ),
        ])
        .unwrap();
        let mut bytes = Vec::new();
        let properties = parquet::file::properties::WriterProperties::builder()
            .set_max_row_group_size(2)
            .build();
        let mut writer =
            parquet::arrow::ArrowWriter::try_new(&mut bytes, batch.schema(), Some(properties))
                .unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
        bytes
    }

    #[test]
    fn reads_what_the_parquet_decoder_reads() {
        let file = written_file();
        let raw = read_raw_footer(footer_of(&file)).unwrap();
        let decoded =
            parquet::file::metadata::ParquetMetaDataReader::decode_metadata(footer_of(&file))
                .unwrap();
        assert_eq!(raw.leaf_types, vec![Some(2), Some(6)]);
        assert_eq!(raw.row_groups.len(), decoded.num_row_groups());
        for (group, chunks) in raw.row_groups.iter().enumerate() {
            assert_eq!(chunks.len(), 2);
            for (leaf, chunk) in chunks.iter().enumerate() {
                let stats = decoded.row_group(group).column(leaf).statistics().unwrap();
                let raw_stats = chunk.statistics.as_ref().unwrap();
                assert_eq!(
                    raw_stats.null_count.map(|n| n as u64),
                    stats.null_count_opt()
                );
                assert_eq!(
                    raw_stats.bound_lengths[3],
                    stats.min_bytes_opt().map(<[u8]>::len)
                );
                assert!(raw.null_count_present(group, leaf));
            }
        }
        raw.check_int96_statistics().unwrap();
    }

    #[test]
    fn truncated_and_absurd_footers_are_errors() {
        let file = written_file();
        let footer = footer_of(&file);
        for end in [0, 1, footer.len() / 2, footer.len() - 1] {
            assert!(read_raw_footer(&footer[..end]).is_err(), "prefix {end}");
        }
        // FileMetaData field 2 (schema): a list of structs claiming
        // 2^31 - 1 elements, which the generated decoder would reserve.
        let absurd = [0x29, 0xFC, 0xFF, 0xFF, 0xFF, 0xFF, 0x07, 0x00];
        let error = read_raw_footer(&absurd).unwrap_err();
        assert!(error.contains("list claims"), "{error}");
        // The same list with a negative length.
        let negative = [0x29, 0xFC, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 0x00];
        let error = read_raw_footer(&negative).unwrap_err();
        assert!(error.contains("negative"), "{error}");
        // An unknown double field with fewer than 8 bytes left.
        let short_double = [0xA7, 0x00, 0x00];
        assert!(read_raw_footer(&short_double).is_err());
    }
}
