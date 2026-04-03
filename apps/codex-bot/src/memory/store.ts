import * as fs from "fs"
import * as path from "path"

export const MEMORY_DIR = path.join(process.cwd(), "memory_system")
export const MAIN_MEMORY_FILE = path.join(MEMORY_DIR, "MAINMEMORY.md")

const DEFAULT_MAIN_MEMORY = `# Main Memory

## About the User

- 

## Learned Facts

- 

## Decisions and Preferences

- 
`

export function ensureMainMemoryFile() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  if (!fs.existsSync(MAIN_MEMORY_FILE)) {
    fs.writeFileSync(MAIN_MEMORY_FILE, DEFAULT_MAIN_MEMORY, "utf8")
  }
}

export function readMainMemory() {
  ensureMainMemoryFile()
  try {
    return fs.readFileSync(MAIN_MEMORY_FILE, "utf8")
  } catch {
    return ""
  }
}

export type MemorySectionKey = "about" | "facts" | "prefs"

const SECTION_LABELS: Record<MemorySectionKey, string> = {
  about: "About the User",
  facts: "Learned Facts",
  prefs: "Decisions and Preferences",
}

function getSectionPattern(section: MemorySectionKey) {
  return new RegExp(`## ${SECTION_LABELS[section]}\\n\\n([\\s\\S]*?)(?=\\n## |$)`)
}

function extractBullets(body: string) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

export function readMainMemorySections() {
  const content = readMainMemory()
  return {
    about: extractBullets(content.match(getSectionPattern("about"))?.[1] || ""),
    facts: extractBullets(content.match(getSectionPattern("facts"))?.[1] || ""),
    prefs: extractBullets(content.match(getSectionPattern("prefs"))?.[1] || ""),
  }
}

function renderSectionBullets(items: string[]) {
  if (items.length === 0) return "- "
  return items.map((item) => `- ${item}`).join("\n")
}

export function writeMainMemorySections(sections: Record<MemorySectionKey, string[]>) {
  ensureMainMemoryFile()
  const content = `# Main Memory

## About the User

${renderSectionBullets(sections.about)}

## Learned Facts

${renderSectionBullets(sections.facts)}

## Decisions and Preferences

${renderSectionBullets(sections.prefs)}
`
  fs.writeFileSync(MAIN_MEMORY_FILE, content, "utf8")
  return content
}

export function normalizeMemorySection(section: string): MemorySectionKey | null {
  const value = section.trim().toLowerCase()
  if (["about", "user", "about-user"].includes(value)) return "about"
  if (["facts", "fact", "learned-facts"].includes(value)) return "facts"
  if (["prefs", "pref", "preferences", "decisions"].includes(value)) return "prefs"
  return null
}

export function addMainMemoryItem(section: MemorySectionKey, text: string) {
  const sections = readMainMemorySections()
  sections[section].push(text.trim())
  writeMainMemorySections(sections)
  return sections[section].length
}

export function editMainMemoryItem(section: MemorySectionKey, index: number, text: string) {
  const sections = readMainMemorySections()
  if (index < 1 || index > sections[section].length) return false
  sections[section][index - 1] = text.trim()
  writeMainMemorySections(sections)
  return true
}

export function removeMainMemoryItem(section: MemorySectionKey, index: number) {
  const sections = readMainMemorySections()
  if (index < 1 || index > sections[section].length) return null
  const [removed] = sections[section].splice(index - 1, 1)
  writeMainMemorySections(sections)
  return removed || null
}

export function searchMainMemory(query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []
  const sections = readMainMemorySections()
  const matches: Array<{ section: MemorySectionKey; index: number; text: string }> = []
  for (const section of Object.keys(sections) as MemorySectionKey[]) {
    sections[section].forEach((item, index) => {
      if (item.toLowerCase().includes(normalizedQuery)) {
        matches.push({ section, index: index + 1, text: item })
      }
    })
  }
  return matches
}
