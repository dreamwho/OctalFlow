import { afterEach, describe, expect, it } from "vitest";
import { canvasExternalApiUser } from "./canvas-external-auth";

const oldKey = process.env.DREAMYO_CANVAS_EXTERNAL_API_KEY;
const oldUser = process.env.DREAMYO_CANVAS_EXTERNAL_API_USER_ID;
afterEach(() => {
    if (oldKey === undefined) delete process.env.DREAMYO_CANVAS_EXTERNAL_API_KEY;
    else process.env.DREAMYO_CANVAS_EXTERNAL_API_KEY = oldKey;
    if (oldUser === undefined) delete process.env.DREAMYO_CANVAS_EXTERNAL_API_USER_ID;
    else process.env.DREAMYO_CANVAS_EXTERNAL_API_USER_ID = oldUser;
});

describe("canvas external API authentication", () => {
    it("accepts only a configured user bound to the exact bearer key", () => {
        process.env.DREAMYO_CANVAS_EXTERNAL_API_KEY = "an-external-key-with-at-least-32-characters";
        process.env.DREAMYO_CANVAS_EXTERNAL_API_USER_ID = "user-1";
        expect(canvasExternalApiUser(new Request("http://local", { headers: { authorization: "Bearer an-external-key-with-at-least-32-characters" } }))).toBe("user-1");
        expect(canvasExternalApiUser(new Request("http://local", { headers: { authorization: "Bearer wrong" } }))).toBeNull();
        delete process.env.DREAMYO_CANVAS_EXTERNAL_API_USER_ID;
        expect(canvasExternalApiUser(new Request("http://local", { headers: { authorization: "Bearer an-external-key-with-at-least-32-characters" } }))).toBeNull();
    });
});
