import type { CSSProperties } from "react";
export type IconName =
  | "book"
  | "grid"
  | "plus"
  | "records"
  | "users"
  | "settings"
  | "search"
  | "refresh"
  | "arrow"
  | "chevron"
  | "download"
  | "shield"
  | "clock"
  | "close"
  | "edit"
  | "trash"
  | "image"
  | "check"
  | "logout"
  | "menu"
  | "external"
  | "alert"
  | "wifi"
  | "calendar"
  | "file"
  | "sun";
const paths: Record<IconName, string> = {
  book: "M4 3h13a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3V3Zm4 0v18M12 8h4m-4 4h4",
  grid: "M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
  plus: "M12 5v14M5 12h14",
  records:
    "M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 4h8m-8 5h8m-8 5h5",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  settings:
    "m9 3-1 3-3 1-2 3 2 2v3l2 3 3-1 2 2 3-1 1-3 3-1 2-3-2-2V8l-2-3-3 1-2-3H9Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 12.8 1L20 9M4 15l1.1 2A8 8 0 0 0 18 18",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  chevron: "m9 5 7 7-7 7",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  clock: "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  close: "m6 6 12 12M6 18 18 6",
  edit: "m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  image: "M3 3h18v18H3V3Zm0 13 5-5 5 5 3-3 5 5M9 7h.01",
  check: "m5 12 4 4L19 6",
  logout: "M9 21H3V3h6m5 5 4 4-4 4m-6-4h13",
  menu: "M4 6h16M4 12h16M4 18h16",
  external: "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7",
  alert: "m12 3 10 18H2L12 3Zm0 5v6m0 3h.01",
  wifi: "M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0m-4 4h.01",
  calendar: "M3 5h18v16H3V5Zm4-3v6m10-6v6M3 10h18",
  file: "M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 13h8m-8 4h5",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
};
export function Icon({
  name,
  size = 20,
  className = "",
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
