const BANGKOK_DATE = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function bangkokDate(now: Date): string {
  const parts = BANGKOK_DATE.formatToParts(now);
  const [year, month, day] = ['year', 'month', 'day'].map(
    (type) => parts.find((part) => part.type === type)!.value,
  );
  return `${year}-${month}-${day}`;
}

/** The stored deadline is a calendar date and remains open through that date in Bangkok. */
export function applicationDeadlinePassed(deadline: Date, now: Date): boolean {
  return deadline.toISOString().slice(0, 10) < bangkokDate(now);
}
