import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "node:fs";

const docsPath = join(import.meta.dir, "../docs");
const vaultPath = "/Users/matincz/Documents/Obsidian Vault/opencode via telegram";
const isWatchMode = process.argv.includes("--watch");

async function syncFile(filename: string) {
    if (!filename.endsWith(".md")) return;

    const sourcePath = join(docsPath, filename);
    const targetPath = join(vaultPath, filename);

    try {
        console.log(`- 同步 [${filename}] ...`);
        const content = await Bun.file(sourcePath).text();
        await mkdir(vaultPath, { recursive: true });
        await Bun.write(targetPath, content);
    } catch (error) {
        console.error(`❌ 同步 ${filename} 失败:`, error);
    }
}

async function syncAll() {
    console.log("🔄 开始同步文档到 Obsidian...");
    try {
        const files = await readdir(docsPath);
        let count = 0;
        for (const file of files) {
            if (file.endsWith(".md")) {
                await syncFile(file);
                count++;
            }
        }
        console.log(`✅ 同步完成！共更新 ${count} 篇文档。`);
    } catch (error) {
        console.error("❌ 同步失败:", error);
    }
}

// 首次运行全量同步
await syncAll();

// 如果开启了 --watch，则监听文件变化
if (isWatchMode) {
    console.log(`\n👀 正在监听 ${docsPath} 的改动... (按 Ctrl+C 退出)`);
    watch(docsPath, async (event, filename) => {
        if (filename && filename.endsWith(".md")) {
            console.log(`\n📝 检测到 ${filename} 发生改动 (${event})`);
            await syncFile(filename);
        }
    });
}
