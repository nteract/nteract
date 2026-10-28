//! Whole-file column statistics merged from Parquet footer metadata.
//!
//! Computed once when a file opens, from the decoded footer plus the raw
//! null-count presence bits the thrift pre-pass records. No byte reads.
//! Values use the store's units (`get_f64_value`): temporal columns in epoch
//! milliseconds, decimals scaled, so a footer range and a loaded-rows range
//! compare directly.

use crate::footer_thrift::RawFooter;
use crate::store::get_f64_value;
use arrow::array::{Array, ArrayRef, BooleanArray};
use arrow::datatypes::{DataType, Field, Schema};
use parquet::arrow::arrow_reader::statistics::StatisticsConverter;
use parquet::basic::{ColumnOrder, SortOrder, Type as PhysicalType};
use parquet::file::metadata::ParquetMetaData;
use parquet::file::statistics::Statistics;
use parquet::schema::types::ColumnDescriptor;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ParquetFileStats {
    pub(crate) num_rows: f64,
    pub(crate) num_row_groups: u32,
    /// One per top-level Arrow column, in schema order.
    pub(crate) columns: Vec<ColumnFileStats>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct ColumnFileStats {
    /// Σ row-group null counts. `None` when any group's count was absent in
    /// the raw thrift, the column is nested, or no leaf maps to it. A REQUIRED
    /// leaf is `Some(0)` with no statistics needed.
    pub(crate) null_count: Option<f64>,
    pub(crate) min: Option<StatValue>,
    pub(crate) max: Option<StatValue>,
    /// Row groups whose bounds were usable, or that were all-null (trusted
    /// null count == rows) or empty. Bounds describe the whole file only when
    /// this equals the row group count.
    pub(crate) bounded_row_groups: u32,
    /// Every row group is bounded and, for byte-array leaves, every
    /// contributing group's bounds are exact rather than truncated.
    pub(crate) bounds_exact: bool,
    /// `min` or `max` is ±Inf.
    pub(crate) has_infinite: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum StatValue {
    Number(f64),
    Text(String),
    Bool(bool),
}

/// How a column's bounds are read and compared.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// Read through `get_f64_value`, so units match the store.
    Number,
    Text,
    Bool,
    /// No bounds Sift can show (binary, Float16, time-of-day, ...).
    None,
}

fn kind_of(data_type: &DataType) -> Kind {
    match data_type {
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64
        | DataType::Float32
        | DataType::Float64
        | DataType::Decimal128(_, _)
        | DataType::Decimal256(_, _)
        | DataType::Timestamp(_, _)
        | DataType::Date32
        | DataType::Date64 => Kind::Number,
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => Kind::Text,
        DataType::Boolean => Kind::Bool,
        DataType::Dictionary(_, values) => kind_of(values),
        _ => Kind::None,
    }
}

pub(crate) fn file_column_stats(
    metadata: &ParquetMetaData,
    schema: &Schema,
    raw: &RawFooter,
) -> ParquetFileStats {
    ParquetFileStats {
        num_rows: metadata.file_metadata().num_rows().max(0) as f64,
        num_row_groups: u32::try_from(metadata.num_row_groups()).unwrap_or(u32::MAX),
        columns: schema
            .fields()
            .iter()
            .enumerate()
            .map(|(index, field)| column_stats(index, field, metadata, schema, raw))
            .collect(),
    }
}

fn column_stats(
    index: usize,
    field: &Field,
    metadata: &ParquetMetaData,
    schema: &Schema,
    raw: &RawFooter,
) -> ColumnFileStats {
    // The converter resolves columns by name; a duplicate name would read
    // the first column's statistics.
    if schema.index_of(field.name()).ok() != Some(index) {
        return ColumnFileStats::default();
    }
    let schema_descr = metadata.file_metadata().schema_descr();
    let Ok(converter) = StatisticsConverter::try_new(field.name(), schema, schema_descr) else {
        return ColumnFileStats::default();
    };
    let Some(leaf) = converter.parquet_column_index() else {
        return ColumnFileStats::default();
    };
    let descr = schema_descr.column(leaf);
    if descr.max_rep_level() > 0 {
        return ColumnFileStats::default();
    }
    let groups = metadata.row_groups();
    let group_stats: Vec<Option<&Statistics>> = groups
        .iter()
        .map(|group| group.column(leaf).statistics())
        .collect();
    // A count is trusted only when the writer actually wrote one.
    let trusted_nulls: Vec<Option<u64>> = group_stats
        .iter()
        .enumerate()
        .map(|(group, stats)| {
            stats
                .filter(|_| raw.null_count_present(group, leaf))
                .and_then(Statistics::null_count_opt)
        })
        .collect();
    let null_count = if descr.max_def_level() == 0 {
        Some(0.0)
    } else {
        trusted_nulls
            .iter()
            .try_fold(0u64, |sum, count| {
                count.map(|count| sum.saturating_add(count))
            })
            .map(|sum| sum as f64)
    };

    let kind = kind_of(field.data_type());
    let file_order = metadata.file_metadata().column_order(leaf);
    let bounds = if kind == Kind::None {
        None
    } else {
        converter
            .row_group_mins(groups.iter())
            .ok()
            .zip(converter.row_group_maxes(groups.iter()).ok())
    };
    let byte_array = matches!(
        descr.physical_type(),
        PhysicalType::BYTE_ARRAY | PhysicalType::FIXED_LEN_BYTE_ARRAY
    );

    let mut min: Option<StatValue> = None;
    let mut max: Option<StatValue> = None;
    let mut bounded_row_groups = 0u32;
    let mut contributing_exact = true;
    for (group, metadata) in groups.iter().enumerate() {
        let stats = group_stats[group];
        let usable = bounds.as_ref().and_then(|(mins, maxes)| {
            if !usable_minmax(stats, &descr, file_order) {
                return None;
            }
            Some((value_at(kind, mins, group)?, value_at(kind, maxes, group)?))
        });
        if let Some((group_min, group_max)) = usable {
            min = Some(match min {
                Some(current) => lesser(current, group_min),
                None => group_min,
            });
            max = Some(match max {
                Some(current) => greater(current, group_max),
                None => group_max,
            });
            if byte_array && !stats.is_some_and(|s| s.min_is_exact() && s.max_is_exact()) {
                contributing_exact = false;
            }
            bounded_row_groups += 1;
            continue;
        }
        let rows = u64::try_from(metadata.num_rows()).unwrap_or(0);
        if rows == 0 || trusted_nulls[group] == Some(rows) {
            bounded_row_groups += 1;
        }
    }
    let has_infinite = [&min, &max]
        .into_iter()
        .any(|value| matches!(value, Some(StatValue::Number(n)) if n.is_infinite()));
    ColumnFileStats {
        null_count,
        min,
        max,
        bounded_row_groups,
        bounds_exact: bounded_row_groups as usize == groups.len() && contributing_exact,
        has_infinite,
    }
}

/// Whether a row group's min/max can be trusted for this column.
fn usable_minmax(
    stats: Option<&Statistics>,
    descr: &ColumnDescriptor,
    file_order: ColumnOrder,
) -> bool {
    let Some(stats) = stats else {
        return false;
    };
    let physical = descr.physical_type();
    let sort_order =
        ColumnOrder::get_sort_order(descr.logical_type(), descr.converted_type(), physical);
    let deprecated = stats.is_min_max_deprecated();
    stats.min_bytes_opt().is_some()
        && stats.max_bytes_opt().is_some()
        && physical != PhysicalType::INT96
        && sort_order != SortOrder::UNDEFINED
        // Legacy min/max were written with signed comparison.
        && !(sort_order == SortOrder::UNSIGNED
            && (deprecated || file_order == ColumnOrder::UNDEFINED))
        // PARQUET-686: legacy binary statistics compared signed bytes.
        && !(matches!(
            physical,
            PhysicalType::BYTE_ARRAY | PhysicalType::FIXED_LEN_BYTE_ARRAY
        ) && deprecated)
}

/// The converted statistic for one row group, or `None` when it is missing,
/// failed conversion, or is NaN.
fn value_at(kind: Kind, values: &ArrayRef, group: usize) -> Option<StatValue> {
    if group >= values.len() || values.is_null(group) {
        return None;
    }
    match kind {
        Kind::Number => {
            let value = get_f64_value(values.as_ref(), group);
            (!value.is_nan()).then_some(StatValue::Number(value))
        }
        Kind::Text => {
            nteract_predicate::arrow_utils::string_at(values.as_ref(), group).map(StatValue::Text)
        }
        Kind::Bool => values
            .as_any()
            .downcast_ref::<BooleanArray>()
            .map(|array| StatValue::Bool(array.value(group))),
        Kind::None => None,
    }
}

fn lesser(a: StatValue, b: StatValue) -> StatValue {
    match (&a, &b) {
        (StatValue::Number(x), StatValue::Number(y)) if y < x => b,
        (StatValue::Text(x), StatValue::Text(y)) if y < x => b,
        (StatValue::Bool(x), StatValue::Bool(y)) if y < x => b,
        _ => a,
    }
}

fn greater(a: StatValue, b: StatValue) -> StatValue {
    match (&a, &b) {
        (StatValue::Number(x), StatValue::Number(y)) if y > x => b,
        (StatValue::Text(x), StatValue::Text(y)) if y > x => b,
        (StatValue::Bool(x), StatValue::Bool(y)) if y > x => b,
        _ => a,
    }
}
