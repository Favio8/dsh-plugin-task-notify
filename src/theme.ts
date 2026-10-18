/**
 * 卡片配色来源：对齐 DSH 设计平台（@deepseek-ai/dsh-client-ui-theme 的
 * design-platform.css 静态色板），让桌面置顶卡片与 DSH 内 toast / 设置页观感一致。
 *
 * 强调色与设置页色板共用本模块，避免 Host 弹窗和 Client 设置页各写一套颜色。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** 强调色色板（rgb 分量）。 */
export const ACCENT_COLORS = {
  /** --dsw-static-green-500 */
  green: { r: 34, g: 197, b: 94 },
  /** --dsw-static-deepseek-500 */
  blue: { r: 65, g: 118, b: 230 },
  /** --dsw-static-amber-500 */
  orange: { r: 245, g: 158, b: 11 },
  /** DSH 无紫色 token，取与色板同一明度/饱和度的过渡色。 */
  purple: { r: 139, g: 92, b: 246 },
  /** --dsw-static-red-500；仅用于错误卡片，不在设置页色板中展示。 */
  red: { r: 239, g: 68, b: 68 },
} as const

export type AccentKey = keyof typeof ACCENT_COLORS

/** 设置页可选的强调色（错误卡片的红色固定，不参与选择）。 */
export const SELECTABLE_ACCENTS: readonly AccentKey[] = ['green', 'blue', 'orange', 'purple']

/** 取强调色的 CSS 颜色串（设置页色板用）。 */
export function accentCss(key: string): string {
  const color = ACCENT_COLORS[key as AccentKey] ?? ACCENT_COLORS.green
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

/** 卡片主题色（与 Host 端 WinForms 模板使用同一组取值）。 */
export interface CardThemeColors {
  surface: string
  border: string
  primary: string
  secondary: string
  tertiary: string
}

export const CARD_THEMES: Record<'dark' | 'light', CardThemeColors> = {
  dark: {
    surface: '#232324',
    border: 'rgba(255, 255, 255, 0.10)',
    primary: '#F9FAFB',
    secondary: '#ADB2B8',
    tertiary: '#81858C',
  },
  light: {
    surface: '#FFFFFF',
    border: 'rgba(0, 0, 0, 0.10)',
    primary: '#0F1115',
    secondary: '#61666B',
    tertiary: '#81858C',
  },
}
