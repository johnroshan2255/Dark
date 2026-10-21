//! Bounds-checked little-endian reader / writer.

use thiserror::Error;

/// Why a packet could not be decoded. Never a panic: the connection layer counts these and drops the client.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DecodeError {
    #[error("packet is empty")]
    Empty,
    #[error("packet truncated: needed {needed} more byte(s) at offset {at}")]
    Truncated { at: usize, needed: usize },
    #[error("unknown packet kind 0x{0:02x}")]
    UnknownKind(u8),
    #[error("unknown {what} value {value}")]
    UnknownValue { what: &'static str, value: u8 },
    #[error("string is not valid UTF-8")]
    BadUtf8,
    #[error("{0} trailing byte(s) after the packet")]
    Trailing(usize),
    #[error("packet larger than {0} bytes")]
    TooLarge(usize),
    #[error("{what}: {count} exceeds the limit {max}")]
    TooMany {
        what: &'static str,
        count: usize,
        max: usize,
    },
}

/// Cursor over a received packet.
pub struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, at: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.buf.len());
        match end {
            Some(end) => {
                let s = &self.buf[self.at..end];
                self.at = end;
                Ok(s)
            }
            None => Err(DecodeError::Truncated {
                at: self.at,
                needed: n - (self.buf.len() - self.at),
            }),
        }
    }

    pub fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }
    pub fn u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    pub fn i16(&mut self) -> Result<i16, DecodeError> {
        let b = self.take(2)?;
        Ok(i16::from_le_bytes([b[0], b[1]]))
    }
    pub fn u32(&mut self) -> Result<u32, DecodeError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn i32(&mut self) -> Result<i32, DecodeError> {
        let b = self.take(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn u64(&mut self) -> Result<u64, DecodeError> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_le_bytes(a))
    }
    /// `u8` length + UTF-8 bytes.
    pub fn str(&mut self) -> Result<String, DecodeError> {
        let n = self.u8()? as usize;
        let b = self.take(n)?;
        std::str::from_utf8(b)
            .map(str::to_owned)
            .map_err(|_| DecodeError::BadUtf8)
    }
    /// `u16` length + UTF-8 bytes (tickets).
    pub fn long_str(&mut self) -> Result<String, DecodeError> {
        let n = self.u16()? as usize;
        let b = self.take(n)?;
        std::str::from_utf8(b)
            .map(str::to_owned)
            .map_err(|_| DecodeError::BadUtf8)
    }
    /// Error unless every byte was consumed.
    pub fn finish(self) -> Result<(), DecodeError> {
        match self.buf.len() - self.at {
            0 => Ok(()),
            n => Err(DecodeError::Trailing(n)),
        }
    }
}

/// Growable packet writer (reuse one per connection / snapshot to avoid allocation).
#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn with_capacity(n: usize) -> Self {
        Self {
            buf: Vec::with_capacity(n),
        }
    }
    pub fn clear(&mut self) {
        self.buf.clear();
    }
    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    pub fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i16(&mut self, v: i16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i32(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    /// `u8` length + bytes; strings longer than 255 bytes are cut at a char boundary.
    pub fn str(&mut self, s: &str) {
        let mut n = s.len().min(255);
        while !s.is_char_boundary(n) {
            n -= 1;
        }
        self.u8(n as u8);
        self.buf.extend_from_slice(&s.as_bytes()[..n]);
    }
    /// `u16` length + bytes (cut at 65 535 bytes).
    pub fn long_str(&mut self, s: &str) {
        let mut n = s.len().min(u16::MAX as usize);
        while !s.is_char_boundary(n) {
            n -= 1;
        }
        self.u16(n as u16);
        self.buf.extend_from_slice(&s.as_bytes()[..n]);
    }
}
