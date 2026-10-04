// Inline SVG icons. Decorative (aria-hidden); give the parent button an aria-label.

function Svg({ className, style, children, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
      {...rest}
    >
      {children}
    </svg>
  );
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const SUIT_PATHS = {
  s: 'M12 2C9 7 4 10 4 14a4 4 0 0 0 7 2.6V20H8v2h8v-2h-3v-3.4A4 4 0 0 0 20 14c0-4-5-7-8-12z',
  h: 'M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z',
  d: 'M12 2l7 10-7 10-7-10z',
  c: 'M12 2a4.2 4.2 0 0 0-3.6 6.3A4.2 4.2 0 1 0 11 14.6V20H8v2h8v-2h-3v-5.4a4.2 4.2 0 1 0 2.6-6.3A4.2 4.2 0 0 0 12 2z',
};

export function Suit({ suit, className, style }) {
  return (
    <Svg className={className} style={style} fill="currentColor">
      <path d={SUIT_PATHS[suit]} />
    </Svg>
  );
}

export function ChevronLeft({ className }) {
  return (
    <Svg className={className} {...STROKE} strokeWidth="2.4">
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

export function ChevronRight({ className }) {
  return (
    <Svg className={className} {...STROKE} strokeWidth="2.4">
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

export function Shield({ className }) {
  return (
    <Svg className={className} {...STROKE} strokeWidth="2">
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </Svg>
  );
}

export function Dots({ className }) {
  return (
    <Svg className={className} fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </Svg>
  );
}

export function Check({ className }) {
  return (
    <Svg className={className} {...STROKE} strokeWidth="3">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function Close({ className }) {
  return (
    <Svg className={className} {...STROKE} strokeWidth="2.6">
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function WifiOff({ className }) {
  return (
    <Svg className={className} {...STROKE} strokeWidth="2.2">
      <path d="M2 9a15 15 0 0 1 6-3.4M22 9a15 15 0 0 0-8-4M5.5 12.5a10 10 0 0 1 3-1.8M18.5 12.5a10 10 0 0 0-3.5-2.1M9 16a5 5 0 0 1 6 0" />
      <circle cx="12" cy="19.5" r="1" fill="currentColor" />
      <path d="M3 3l18 18" />
    </Svg>
  );
}

/** A poker chip: a solid disc with a dashed rim. */
export function ChipIcon({ className, tone = 'red' }) {
  const fill = tone === 'white' ? '#f4f4f5' : tone === 'black' ? '#1a1a1c' : '#f02849';
  const rim = tone === 'white' ? '#101010' : '#ffffff';
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="11" fill={fill} />
      <circle
        cx="12"
        cy="12"
        r="8.6"
        fill="none"
        stroke={rim}
        strokeWidth="2.4"
        strokeDasharray="3.3 3.3"
        opacity="0.92"
      />
      <circle cx="12" cy="12" r="5" fill={fill} stroke="rgb(0 0 0 / 0.28)" strokeWidth="0.8" />
    </Svg>
  );
}

export function Logo({ size = 72, className }) {
  return (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="48" cy="48" r="44" fill="#f02849" />
      <circle
        cx="48"
        cy="48"
        r="35"
        fill="none"
        stroke="#fff"
        strokeWidth="6"
        strokeDasharray="11 11"
      />
      <circle cx="48" cy="48" r="26" fill="#000" />
      <path
        transform="translate(48 49) scale(0.8) translate(-48 -48)"
        d="M48 31c-8 12-20 17-20 28a10 10 0 0 0 17 7v10h-5v5h16v-5h-5V66a10 10 0 0 0 17-7c0-11-12-16-20-28z"
        fill="#fff"
      />
    </svg>
  );
}
