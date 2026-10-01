import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), install: vi.fn(), redirect: vi.fn((path: string) => { throw new Error(path); }) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/install-status", () => ({ getInstallStatus: mocks.install }));
import LoginPage from "./page";

beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(null); mocks.install.mockResolvedValue({ ready: true }); });
it("redirects visitors to the homepage modal with the original destination", async () => {
    await expect(LoginPage({ searchParams: Promise.resolve({ next: "/admin", error: "授权失败" }) })).rejects.toThrow("/?login=1&next=%2Fadmin&error=%E6%8E%88%E6%9D%83%E5%A4%B1%E8%B4%A5");
});
it("sends signed-in users directly to their destination", async () => {
    mocks.user.mockResolvedValue({ id: "admin" });
    await expect(LoginPage({ searchParams: Promise.resolve({ next: "/admin" }) })).rejects.toThrow("/admin");
});
it("retains the installation guard", async () => {
    mocks.install.mockResolvedValue({ ready: false });
    await expect(LoginPage({})).rejects.toThrow("/install");
    expect(mocks.user).not.toHaveBeenCalled();
});
