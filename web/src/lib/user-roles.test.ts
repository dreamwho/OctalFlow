import { describe, expect, it } from "vitest";

import { DEFAULT_USER_ROLE, roleModelAccessAllows, userRoleDefinitionsValidationError } from "./user-roles";

describe("user role model access", () => {
    it("defaults ordinary users to all model categories and models", () => {
        expect(roleModelAccessAllows([DEFAULT_USER_ROLE], "user", "dola-seedance-2-5", "video")).toBe(true);
        expect(roleModelAccessAllows([DEFAULT_USER_ROLE], "user", "nano-banana", "image")).toBe(true);
    });

    it("allows a selected category plus individually selected models", () => {
        const roles = [{
            ...DEFAULT_USER_ROLE,
            id: "honor",
            name: "荣誉会员",
            modelAccess: { all: false, capabilities: ["image" as const], modelIds: ["dola-seedance-2-5"], excludedModelIds: [] },
        }];

        expect(roleModelAccessAllows(roles, "honor", "image-model", "image")).toBe(true);
        expect(roleModelAccessAllows(roles, "honor", "dola-seedance-2-5", "video")).toBe(true);
        expect(roleModelAccessAllows(roles, "honor", "another-video", "video")).toBe(false);
        expect(roleModelAccessAllows(roles, "admin", "another-video", "video")).toBe(true);
    });

    it("lets an individual model exclusion override an all-model grant", () => {
        const roles = [{ ...DEFAULT_USER_ROLE, modelAccess: { ...DEFAULT_USER_ROLE.modelAccess, excludedModelIds: ["dola-seedance-2-5"] } }];
        expect(roleModelAccessAllows(roles, "user", "dola-seedance-2-5", "video")).toBe(false);
        expect(roleModelAccessAllows(roles, "user", "other-video", "video")).toBe(true);
    });

    it("requires the built-in user role and rejects admin role definitions", () => {
        expect(userRoleDefinitionsValidationError([{ ...DEFAULT_USER_ROLE, id: "honor" }])).toContain("必须保留普通用户");
        expect(userRoleDefinitionsValidationError([DEFAULT_USER_ROLE, { ...DEFAULT_USER_ROLE, id: "admin", name: "管理员" }])).toContain("不能使用 admin");
        expect(userRoleDefinitionsValidationError([DEFAULT_USER_ROLE, { ...DEFAULT_USER_ROLE, id: "honor", name: "荣誉会员" }])).toBe("");
    });
});
