import { describe, expect, it } from 'vitest';
import { alertRules, reaches } from '@/earmark/alerts';

// D-46: the dashboard's "Lines at risk" and the alerts cron share one comparison and one rules file.
describe('reaches (D-46)', () => {
  it('is inclusive at the threshold and exact in integer cents', () => {
    expect(reaches(80_00n, 100_00n, 80)).toBe(true);
    expect(reaches(79_99n, 100_00n, 80)).toBe(false);
    expect(reaches(100_00n, 100_00n, 100)).toBe(true);
    expect(reaches(99_99n, 100_00n, 100)).toBe(false);
  });
  it('reads the thresholds the cron uses', () => {
    expect(alertRules()).toMatchObject({ committedPercent: 80, actualPercent: 100, unmatchedDays: 14 });
  });
});
