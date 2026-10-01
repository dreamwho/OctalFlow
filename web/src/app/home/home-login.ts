type SearchParams = Record<string, string | string[] | undefined>;

export function readHomeLogin(params: SearchParams) {
    const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
    const next = first(params.next) || "";
    const safe = next.startsWith("/") && !next.startsWith("//") && !/[\\\s]/.test(next) && next.split(/[?#]/, 1)[0] !== "/login";
    return { nextPath: safe ? next : "/create", authError: first(params.error) || "" };
}
