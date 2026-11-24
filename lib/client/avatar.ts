// Cute, deterministic cartoon avatars (pure SVG, no assets). Same member → same face everywhere.
const SKIN = ["#FFD9B8", "#F3C097", "#D9A177", "#A86F4C"];
const HAIR = ["#2B1D14", "#4A2E1F", "#7A4A24", "#C68A3C", "#151515", "#8C3B2E"];
const CHEEK = "#FF8FA3";

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 64×64 SVG string. `bg` is the member colour. */
export function avatarSvg(seed: string, bg: string, size = 40): string {
  const h = hash(seed);
  const skin = SKIN[h % SKIN.length];
  const hair = HAIR[(h >>> 3) % HAIR.length];
  const style = (h >>> 6) % 5;      // hair style
  const acc = (h >>> 9) % 6;        // accessory
  const face = (h >>> 12) % 3;      // expression

  const hairPath = [
    // 0 short
    `<path d="M14 34c0-12 8-20 18-20s18 8 18 20c-4-6-10-9-18-9s-14 3-18 9z" fill="${hair}"/>`,
    // 1 bob
    `<path d="M12 40c-1-16 8-26 20-26s21 10 20 26c-2-1-3-3-4-6-2-6-8-11-16-11s-14 5-16 11c-1 3-2 5-4 6z" fill="${hair}"/>`,
    // 2 bun
    `<circle cx="32" cy="12" r="7" fill="${hair}"/><path d="M14 34c0-12 8-19 18-19s18 7 18 19c-5-5-11-8-18-8s-13 3-18 8z" fill="${hair}"/>`,
    // 3 spiky
    `<path d="M14 34l2-12 5 5 3-10 5 7 4-9 4 9 5-7 3 10 5-5 2 12c-5-6-11-9-18-9s-13 3-18 9z" fill="${hair}"/>`,
    // 4 side part
    `<path d="M14 36c0-13 8-22 19-22 10 0 17 8 17 18-6-2-12-7-15-12-3 7-11 13-21 16z" fill="${hair}"/>`,
  ][style];

  const eyes = face === 2
    ? `<circle cx="25" cy="37" r="2.6" fill="#1E1A17"/><path d="M36 37q3-3 6 0" stroke="#1E1A17" stroke-width="2.2" fill="none" stroke-linecap="round"/>`
    : `<circle cx="25" cy="37" r="2.6" fill="#1E1A17"/><circle cx="39" cy="37" r="2.6" fill="#1E1A17"/><circle cx="25.9" cy="36.1" r=".9" fill="#fff"/><circle cx="39.9" cy="36.1" r=".9" fill="#fff"/>`;
  const mouth = face === 1
    ? `<path d="M26 44q6 7 12 0z" fill="#7A2E2E"/>`
    : `<path d="M27 44q5 5 10 0" stroke="#7A2E2E" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;

  const accessory = [
    "",
    // sunglasses
    `<g fill="#1E1A17"><rect x="18.5" y="33" width="11" height="7.5" rx="3"/><rect x="34.5" y="33" width="11" height="7.5" rx="3"/><rect x="29" y="35" width="6" height="1.8"/></g>`,
    // travel bucket hat
    `<path d="M15 25c2-9 9-13 17-13s15 4 17 13z" fill="#F2B705"/><path d="M9 27c6-3 14-4 23-4s17 1 23 4c-2 2-4 2-6 2H15c-2 0-4 0-6-2z" fill="#D49A00"/>`,
    // flower
    `<g transform="translate(46 19)"><circle r="3.4" cx="0" cy="-3.6" fill="#FF7AA2"/><circle r="3.4" cx="3.4" cy="0" fill="#FF7AA2"/><circle r="3.4" cx="0" cy="3.6" fill="#FF7AA2"/><circle r="3.4" cx="-3.4" cy="0" fill="#FF7AA2"/><circle r="2.2" fill="#FFD447"/></g>`,
    // cap
    `<path d="M14 28c1-9 8-14 18-14s17 5 18 14z" fill="#2563C9"/><path d="M32 27h22c1 0 1 3-1 3H32z" fill="#1B4FA3"/>`,
    "",
  ][acc];

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
<circle cx="32" cy="32" r="32" fill="${bg}"/>
<path d="M14 64c2-11 9-16 18-16s16 5 18 16z" fill="#fff" opacity=".92"/>
<circle cx="32" cy="36" r="17" fill="${skin}"/>
<circle cx="15" cy="37" r="3.5" fill="${skin}"/><circle cx="49" cy="37" r="3.5" fill="${skin}"/>
${hairPath}
${eyes}
<circle cx="21.5" cy="43" r="3" fill="${CHEEK}" opacity=".55"/><circle cx="42.5" cy="43" r="3" fill="${CHEEK}" opacity=".55"/>
${mouth}
${accessory}
</svg>`;
}

export function avatarDataUrl(seed: string, bg: string) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg(seed, bg, 64))}`;
}
