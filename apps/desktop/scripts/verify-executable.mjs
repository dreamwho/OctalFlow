import { open } from "node:fs/promises";

const MACHO_64 = 0xfeedfacf;
const MACHO_FAT = 0xcafebabe;
const MACHO_FAT_64 = 0xcafebabf;
const MACHO_CPU = { arm64: 0x0100000c, x64: 0x01000007 };
const PE_MACHINE = { arm64: 0xaa64, x64: 0x8664 };

export async function verifyExecutable(file, platform, arch) {
    if (platform !== "darwin" && platform !== "win32") throw new Error(`不支持的平台：${platform}`);
    if (arch !== "arm64" && arch !== "x64") throw new Error(`不支持的架构：${arch}`);
    const handle = await open(file, "r");
    try {
        const header = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const supported = platform === "darwin" ? isMachO(header, bytesRead, MACHO_CPU[arch]) : isPe(header, bytesRead, PE_MACHINE[arch]);
        if (!supported) throw new Error(`桌面安装包运行文件架构不匹配：${file}（需要 ${platform}-${arch}）`);
    } finally {
        await handle.close();
    }
}

function isMachO(header, length, cpu) {
    if (length < 8) return false;
    const magic = header.readUInt32BE(0);
    if (magic === MACHO_64) return header.readUInt32BE(4) === cpu;
    if (header.readUInt32LE(0) === MACHO_64) return header.readUInt32LE(4) === cpu;
    if (magic !== MACHO_FAT && magic !== MACHO_FAT_64) return false;
    const count = header.readUInt32BE(4);
    const entrySize = magic === MACHO_FAT ? 20 : 32;
    if (count < 1 || count > 32 || 8 + count * entrySize > length) return false;
    for (let index = 0; index < count; index++) {
        if (header.readUInt32BE(8 + index * entrySize) === cpu) return true;
    }
    return false;
}

function isPe(header, length, machine) {
    if (length < 0x40 || header.toString("ascii", 0, 2) !== "MZ") return false;
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 6 > length) return false;
    return header.toString("ascii", peOffset, peOffset + 4) === "PE\0\0" && header.readUInt16LE(peOffset + 4) === machine;
}
