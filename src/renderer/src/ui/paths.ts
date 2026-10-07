/** Non-empty segments of a file system path; splits on both `/` and `\` (Windows). */
export const pathSegments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean)
