//! 零依赖的时间工具：Unix 时间 → 民用日期 / 展示字符串。
//!
//! extractor（合并导出包的生成时间）与 zipper（zip 条目的时间戳）共用；
//! 不引 chrono，换算逻辑就是全部内容，有测试守着。

/// 把 Unix 天数换算成 (年, 月, 日)，1970-01-01 为第 0 天。零依赖的民用历换算。
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let yd = if leap { 366 } else { 365 };
        if d >= yd {
            d -= yd;
            y += 1;
        } else {
            break;
        }
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mdays = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 0usize;
    while m < 11 && d >= mdays[m] as i64 {
        d -= mdays[m] as i64;
        m += 1;
    }
    (y, m as u32 + 1, d as u32 + 1)
}

/// 依赖零成本的本地时间字符串（yyyy-MM-dd HH:mm:ss UTC）
pub fn now_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC", y, m, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_string_looks_like_a_date() {
        let s = now_string();
        assert_eq!(s.len(), 23, "got {s}");
        assert!(s.ends_with(" UTC"));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], " ");
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19723), (2024, 1, 1));
        assert_eq!(civil_from_days(20709), (2026, 9, 13));
    }
}
