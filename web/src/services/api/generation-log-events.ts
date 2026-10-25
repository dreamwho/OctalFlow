export function subscribeGenerationLogEvents(handlers: { changed: () => void; sync: () => void; connected: (value: boolean) => void }) {
    const source = new EventSource("/api/generation-logs/events");
    source.onopen = () => handlers.connected(true);
    source.onerror = () => handlers.connected(false);
    source.addEventListener("logs.changed", handlers.changed);
    source.addEventListener("logs.sync", handlers.sync);
    return () => source.close();
}
