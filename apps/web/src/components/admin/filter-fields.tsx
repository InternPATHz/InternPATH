/** ช่องกรองและกล่องข้อความที่หน้ารายการของ Admin ใช้ร่วมกัน */
export function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]>;
}) {
  return (
    <label className="text-sm">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary">
        {options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}
      </select>
    </label>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'success'; children: React.ReactNode }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg px-4 py-3 text-sm ${tone === 'error' ? 'bg-danger-soft text-danger-text' : 'bg-success-soft text-success-text'}`}>
      {children}
    </p>
  );
}
