'use client';

// Star display + picker (v0.5b — API.md §1.38/§1.40). Display-only by default;
// pass onChange for the review/place-review pickers. Stars on PEOPLE are
// safety information behind a real contact — never rendered on any ranked or
// comparative surface (ADR-012; PSYCHOLOGY design rule 3).
import st from './board.module.css';

export default function Stars({ value, label }: { value: number; label?: string }) {
  return (
    <span className={st.stars} role="img" aria-label={label ?? `${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} aria-hidden className={n <= Math.round(value) ? undefined : st.starDim}>
          ★
        </span>
      ))}
    </span>
  );
}

export function StarPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (rating: number) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
          className={st.starBtn}
          onClick={() => onChange(n)}
        >
          <span aria-hidden className={value !== null && n <= value ? undefined : st.starDim}>
            ★
          </span>
        </button>
      ))}
    </div>
  );
}
