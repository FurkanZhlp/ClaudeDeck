/**
 * Whether profile optimization runs on the platform. Disabled on Windows until its permission
 * rules are verified there. Main (OptimizeManager) and the renderer (via the preload) must agree,
 * so both derive it from this helper.
 */
export function optimizeSupported(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}
