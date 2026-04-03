export function escapeGeminiAttachmentPath(filePath: string) {
  if (process.platform === "win32") {
    return /[\s&()[\]{}^=;!'+,`~%$@#]/.test(filePath) ? `"${filePath}"` : filePath
  }

  return filePath.replace(/([ \t()[\]{};|*?$`'"#&<>!~\\])/g, "\\$1")
}

export function formatGeminiAttachmentReference(filePath: string) {
  return `@${escapeGeminiAttachmentPath(filePath)}`
}
