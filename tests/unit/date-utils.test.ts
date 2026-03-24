import { describe, it, expect, beforeEach } from 'vitest';
import { localDate, localDateWithDay, localTimestamp, setTimezone, getTimezone } from '../../src/utils/date.js';

describe('date utils', () => {
  beforeEach(() => {
    setTimezone(undefined);
  });

  describe('localDate', () => {
    it('returns YYYY-MM-DD format', () => {
      const result = localDate();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('uses configured timezone', () => {
      // Use a timezone that is always a different date than UTC at certain times
      // At 2026-01-15T23:30:00Z, UTC date is 2026-01-15 but Tokyo (UTC+9) is 2026-01-16
      setTimezone('Asia/Tokyo');
      const date = new Date('2026-01-15T23:30:00Z');
      expect(localDate(date)).toBe('2026-01-16');
    });

    it('respects UTC timezone config', () => {
      setTimezone('UTC');
      const date = new Date('2026-01-15T23:30:00Z');
      expect(localDate(date)).toBe('2026-01-15');
    });

    it('handles CET timezone', () => {
      // At 2026-01-15T23:30:00Z, CET (UTC+1) is 2026-01-16 00:30
      setTimezone('Europe/Warsaw');
      const date = new Date('2026-01-15T23:30:00Z');
      expect(localDate(date)).toBe('2026-01-16');
    });
  });

  describe('localDateWithDay', () => {
    it('returns YYYY-MM-DD (DayName) format', () => {
      setTimezone('UTC');
      // 2026-01-15 is a Thursday
      const date = new Date('2026-01-15T12:00:00Z');
      expect(localDateWithDay(date)).toBe('2026-01-15 (Thursday)');
    });

    it('uses configured timezone for day name', () => {
      // At 2026-01-15T23:30:00Z, UTC is Thursday Jan 15 but Tokyo (UTC+9) is Friday Jan 16
      setTimezone('Asia/Tokyo');
      const date = new Date('2026-01-15T23:30:00Z');
      expect(localDateWithDay(date)).toBe('2026-01-16 (Friday)');
    });

    it('returns correct day for Warsaw timezone', () => {
      setTimezone('Europe/Warsaw');
      // 2026-03-23 is a Monday
      const date = new Date('2026-03-23T12:00:00Z');
      expect(localDateWithDay(date)).toBe('2026-03-23 (Monday)');
    });
  });

  describe('localTimestamp', () => {
    it('returns YYYY-MM-DD HH:MM:SS format', () => {
      const result = localTimestamp();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('uses configured timezone for time', () => {
      setTimezone('Asia/Tokyo'); // UTC+9
      const date = new Date('2026-06-15T10:00:00Z');
      expect(localTimestamp(date)).toBe('2026-06-15 19:00:00');
    });
  });

  describe('getTimezone', () => {
    it('auto-detects system timezone when not configured', () => {
      setTimezone(undefined);
      const tz = getTimezone();
      // Should return a valid IANA timezone string
      expect(tz).toBeTruthy();
      expect(typeof tz).toBe('string');
    });

    it('returns configured timezone when set', () => {
      setTimezone('America/New_York');
      expect(getTimezone()).toBe('America/New_York');
    });
  });

  describe('regression: UTC vs local date mismatch', () => {
    it('does not return UTC date when timezone is configured', () => {
      // This is the exact bug: at 00:30 CET, toISOString() gives previous day
      setTimezone('Europe/Warsaw');
      // CET is UTC+1 in winter, so 00:30 CET = 23:30 UTC previous day
      const date = new Date('2026-01-15T23:30:00Z'); // 00:30 CET on Jan 16
      const result = localDate(date);
      // Must be Jan 16 (CET), NOT Jan 15 (UTC)
      expect(result).toBe('2026-01-16');
    });
  });
});
