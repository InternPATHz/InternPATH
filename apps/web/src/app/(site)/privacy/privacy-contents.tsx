'use client';

import { useEffect, useState } from 'react';

const sections = [
  ['collect', '1. ข้อมูลที่เราเก็บ'],
  ['purpose', '2. วัตถุประสงค์การใช้'],
  ['visible', '3. ใครมองเห็นข้อมูลของคุณ'],
  ['security', '4. การรักษาความปลอดภัย'],
  ['browser', '5. ข้อมูลที่เก็บในเบราว์เซอร์'],
  ['retention', '6. การเก็บรักษาและการลบบัญชี'],
  ['rights', '7. สิทธิ์ของคุณ'],
  ['changes', '8. การแก้ไขนโยบาย'],
  ['contact', '9. ติดต่อเรา'],
];

export function PrivacyContents() {
  const [current, setCurrent] = useState(sections[0][0]);

  useEffect(() => {
    function updateCurrent() {
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
      if (atBottom) {
        const hash = window.location.hash.slice(1);
        const heading = sections.some(([id]) => id === hash) ? document.getElementById(hash) : null;
        const top = heading?.getBoundingClientRect().top;
        setCurrent(top !== undefined && top >= 0 && top < window.innerHeight ? hash : sections[sections.length - 1][0]);
        return;
      }

      let active = sections[0][0];
      for (const [id] of sections) {
        const heading = document.getElementById(id);
        if (heading && heading.getBoundingClientRect().top <= 112) active = id;
      }
      setCurrent(active);
    }

    updateCurrent();
    window.addEventListener('scroll', updateCurrent, { passive: true });
    window.addEventListener('resize', updateCurrent);
    window.addEventListener('hashchange', updateCurrent);
    return () => {
      window.removeEventListener('scroll', updateCurrent);
      window.removeEventListener('resize', updateCurrent);
      window.removeEventListener('hashchange', updateCurrent);
    };
  }, []);

  return (
    <nav aria-label="สารบัญ" className="min-w-0 text-sm min-[834px]:sticky min-[834px]:top-20 min-[834px]:max-h-[calc(100dvh-6rem)] min-[834px]:overflow-y-auto">
      <h2 className="mb-3 text-xs font-semibold text-ink-soft">สารบัญ</h2>
      <ol className="flex gap-2 overflow-x-auto pb-2 min-[834px]:grid min-[834px]:gap-0 min-[834px]:overflow-visible">
        {sections.map(([id, label]) => (
          <li key={id} className="shrink-0">
            <a href={`#${id}`} aria-current={id === current ? 'location' : undefined}
              className="block whitespace-nowrap rounded-full border border-border px-3 py-2 text-ink hover:text-primary aria-[current=location]:border-ink aria-[current=location]:font-semibold min-[834px]:whitespace-normal min-[834px]:rounded-none min-[834px]:border-y-0 min-[834px]:border-r-0">
              {label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
