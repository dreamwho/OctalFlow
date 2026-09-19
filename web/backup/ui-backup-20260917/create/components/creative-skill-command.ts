export type CreativeSkillCommand = {
    start: number;
    end: number;
    query: string;
};

export function creativeSkillCommandAtCursor(value: string, cursor: number): CreativeSkillCommand | null {
    const safeCursor = Math.max(0, Math.min(cursor, value.length));
    const before = value.slice(0, safeCursor);
    const match = before.match(/(?:^|\s)\/([^\s/]*)$/u);
    if (!match) return null;
    const slashOffset = match[0].lastIndexOf("/");
    const start = safeCursor - match[0].length + slashOffset;
    return { start, end: safeCursor, query: match[1] || "" };
}

export function removeCreativeSkillCommand(value: string, command: CreativeSkillCommand) {
    const before = value.slice(0, command.start);
    let after = value.slice(command.end);
    if (/\s$/u.test(before) && /^\s/u.test(after)) after = after.slice(1);
    return { value: `${before}${after}`, cursor: before.length };
}

export function creativeSkillMatchesQuery(skill: { name: string; description: string }, query: string) {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return true;
    return `${skill.name}\n${skill.description}`.toLocaleLowerCase("zh-CN").includes(normalized);
}
