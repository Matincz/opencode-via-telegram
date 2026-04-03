import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  buildSelectableProviders,
  getProjectOpencodeConfigPath,
  loadLocalProviderState,
} from "./model-catalog"

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8")
}

describe("loadLocalProviderState", () => {
  let tempDir = ""

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = ""
  })

  it("merges global and project provider config", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-catalog-"))
    const globalConfigPath = path.join(tempDir, "global-opencode.json")
    const authPath = path.join(tempDir, "auth.json")
    const projectDir = path.join(tempDir, "project")

    writeJson(globalConfigPath, {
      provider: {
        bailian: {
          models: {
            "qwen3.5-plus": { name: "Qwen3.5 Plus" },
          },
        },
        google: {
          blacklist: ["gemini-1.5-pro"],
        },
      },
    })
    writeJson(getProjectOpencodeConfigPath(projectDir), {
      provider: {
        bailian: {
          models: {
            "glm-5": { name: "GLM-5" },
          },
        },
        google: {
          whitelist: ["gemini-2.5-pro"],
        },
      },
    })
    writeJson(authPath, {
      google: { type: "api", key: "x" },
    })

    const state = loadLocalProviderState({
      projectDir,
      globalConfigPath,
      authPath,
    })

    expect(Array.from(state.authProviderIds)).toEqual(["google"])
    expect(Object.keys(state.providerConfig.bailian?.models ?? {}).sort()).toEqual(["glm-5", "qwen3.5-plus"])
    expect(state.providerConfig.google?.blacklist).toEqual(["gemini-1.5-pro"])
    expect(state.providerConfig.google?.whitelist).toEqual(["gemini-2.5-pro"])
    expect(state.projectConfigPath).toBe(getProjectOpencodeConfigPath(projectDir))
  })
})

describe("buildSelectableProviders", () => {
  it("limits custom providers to explicitly configured models", () => {
    const providers = buildSelectableProviders({
      serverProviders: [
        {
          id: "bailian",
          models: {
            "qwen3.5-plus": { name: "Qwen3.5 Plus" },
            "glm-5": { name: "GLM-5" },
            "kimi-k2.5": { name: "Kimi K2.5" },
          },
        },
      ],
      state: {
        authProviderIds: new Set<string>(),
        providerConfig: {
          bailian: {
            models: {
              "qwen3.5-plus": {},
              "glm-5": {},
            },
          },
        },
        authPath: "",
        globalConfigPath: "",
      },
    })

    expect(Object.keys(providers[0]?.models ?? {})).toEqual(["qwen3.5-plus", "glm-5"])
  })

  it("keeps full server model list for auth-backed providers", () => {
    const providers = buildSelectableProviders({
      serverProviders: [
        {
          id: "openai",
          models: {
            "gpt-5.4": { name: "GPT-5.4" },
            "gpt-5.3-codex": { name: "GPT-5.3 Codex" },
          },
        },
      ],
      state: {
        authProviderIds: new Set<string>(["openai"]),
        providerConfig: {
          openai: {
            models: {
              "gpt-5.4": {},
            },
          },
        },
        authPath: "",
        globalConfigPath: "",
      },
    })

    expect(Object.keys(providers[0]?.models ?? {})).toEqual(["gpt-5.4", "gpt-5.3-codex"])
  })

  it("respects whitelist and blacklist filters", () => {
    const providers = buildSelectableProviders({
      serverProviders: [
        {
          id: "google",
          models: {
            "gemini-1.5-pro": { name: "Gemini 1.5 Pro" },
            "gemini-2.5-flash": { name: "Gemini 2.5 Flash" },
            "gemini-2.5-pro": { name: "Gemini 2.5 Pro" },
          },
        },
      ],
      state: {
        authProviderIds: new Set<string>(["google"]),
        providerConfig: {
          google: {
            whitelist: ["gemini-2.5-flash", "gemini-2.5-pro"],
            blacklist: ["gemini-2.5-flash"],
          },
        },
        authPath: "",
        globalConfigPath: "",
      },
    })

    expect(Object.keys(providers[0]?.models ?? {})).toEqual(["gemini-2.5-pro"])
  })
})
