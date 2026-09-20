"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookOpen, CircleHelp, Gift, History, LogOut, ShoppingBag, User, UserCog } from "lucide-react";

import { CreditSymbol, formatCreditAmount } from "@/constant/credits";
import { cn } from "@/lib/utils";

type AccountActionsClusterProps = {
    authenticated: boolean;
    displayName?: string;
    accountId?: string;
    avatarUrl?: string;
    pointsBalance?: number;
    onBilling: () => void;
    onInvite: () => void;
    onNavigate: (path: string) => void;
    onLogout: () => void;
    onLogin: () => void;
};

/**
 * 首页/画布通用的右上角账号区：积分限时特惠 + 邀请赠积分两枚流光胶囊，
 * 头像点击弹出按头像锚定的账号面板（Portal，外点/Esc 关闭）。
 */
export function AccountActionsCluster({ authenticated, displayName, accountId, avatarUrl, pointsBalance = 0, onBilling, onInvite, onNavigate, onLogout, onLogin }: AccountActionsClusterProps) {
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const avatarRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const paddedAccountId = String(accountId || "").padStart(4, "0");

    const toggle = () => {
        const rect = avatarRef.current?.getBoundingClientRect();
        if (!rect) return;
        setAnchor(rect);
        setOpen((current) => !current);
    };

    useEffect(() => {
        if (!open) return;
        const syncAnchor = () => {
            const rect = avatarRef.current?.getBoundingClientRect();
            if (rect) setAnchor(rect);
        };
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (avatarRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        window.addEventListener("resize", syncAnchor);
        window.addEventListener("scroll", syncAnchor, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        window.addEventListener("keydown", closeOnEscape);
        return () => {
            window.removeEventListener("resize", syncAnchor);
            window.removeEventListener("scroll", syncAnchor, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
            window.removeEventListener("keydown", closeOnEscape);
        };
    }, [open]);

    const menuItems: Array<{ key: string; label: string; icon: ReactNode; onClick: () => void; danger?: boolean }> = authenticated
        ? [
              { key: "profile", label: "账号管理", icon: <UserCog className="size-4" />, onClick: () => onNavigate("/profile") },
              { key: "billing", label: "购买记录", icon: <ShoppingBag className="size-4" />, onClick: () => onNavigate("/billing") },
              { key: "usage", label: "使用记录", icon: <History className="size-4" />, onClick: () => onNavigate("/me") },
              { key: "help", label: "常见问题", icon: <CircleHelp className="size-4" />, onClick: () => onNavigate("/help") },
              { key: "tutorial", label: "使用教程", icon: <BookOpen className="size-4" />, onClick: () => onNavigate("/help") },
              { key: "logout", label: "退出登录", icon: <LogOut className="size-4" />, onClick: onLogout, danger: true },
          ]
        : [];

    return (
        <div className="inline-flex items-center gap-2">
            {!authenticated ? (
                <button type="button" className="octal-header-pill" onClick={onLogin} aria-label="登录">
                    <User className="size-4" aria-hidden="true" />
                    <span>登录</span>
                </button>
            ) : (
                <>
                    <button type="button" className="octal-header-pill" onClick={onBilling} aria-label="积分与限时特惠">
                        <CreditSymbol className="text-amber-300" />
                        <span className="tabular-nums">{formatCreditAmount(pointsBalance)}</span>
                        <span>限时特惠</span>
                    </button>
                    <button type="button" className="octal-header-pill" onClick={onInvite} aria-label="邀请赠积分">
                        <Gift className="size-4 text-pink-400" aria-hidden="true" />
                        <span>邀请赠积分</span>
                    </button>
                    <button ref={avatarRef} type="button" className="octal-avatar-button" aria-label="打开账号菜单" aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
                        {avatarUrl ? (
                            <img src={avatarUrl} alt="" className="size-full rounded-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                            <span>{(displayName || "D").slice(0, 2).toUpperCase()}</span>
                        )}
                    </button>
                </>
            )}

            {open && anchor
                ? createPortal(
                      <div
                          ref={panelRef}
                          role="dialog"
                          aria-label="账号菜单"
                          className="fixed z-[1300]"
                          style={{ top: anchor.bottom + 10, right: Math.max(12, window.innerWidth - anchor.right) }}
                          onPointerDown={(event) => event.stopPropagation()}
                      >
                          {authenticated ? (
                              <div className="w-[288px] rounded-2xl border border-white/10 bg-[#12151f]/[0.97] p-3 shadow-[0_24px_70px_rgba(0,0,0,0.6)] backdrop-blur-xl">
                                  <div className="flex items-center gap-3 px-1.5 pb-3 pt-1">
                                      {avatarUrl ? (
                                          <img src={avatarUrl} alt="" className="size-11 rounded-full object-cover ring-2 ring-white/15" referrerPolicy="no-referrer" />
                                      ) : (
                                          <span className="grid size-11 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-sm font-bold text-white">{(displayName || "D").slice(0, 1).toUpperCase()}</span>
                                      )}
                                      <div className="min-w-0">
                                          <p className="truncate text-[15px] font-semibold text-white">{displayName || "创作者"}</p>
                                          <p className="mt-0.5 text-xs text-zinc-500">ID：{paddedAccountId}</p>
                                      </div>
                                  </div>
                                  <div className="rounded-xl bg-white/[0.05] p-3.5">
                                      <div className="flex items-center justify-between gap-2">
                                          <span className="text-sm font-medium text-zinc-300">我的积分</span>
                                          <button
                                              type="button"
                                              className="cursor-pointer rounded-full bg-white px-3.5 py-1 text-xs font-semibold transition hover:bg-zinc-200"
                                              style={{ color: "#0b0f19" }}
                                              onClick={() => {
                                                  setOpen(false);
                                                  onBilling();
                                              }}
                                          >
                                              购买
                                          </button>
                                      </div>
                                      <p className="mt-2 flex items-center gap-1.5 text-2xl font-bold tabular-nums text-white">
                                          <CreditSymbol className="text-amber-300" />
                                          {formatCreditAmount(pointsBalance)}
                                      </p>
                                  </div>
                                  <div className="mt-3 rounded-xl bg-white/[0.04] px-3.5 py-2.5">
                                      <p className="flex items-center justify-between text-xs text-zinc-400">
                                          <span>每日积分随套餐自动发放</span>
                                          <span className="font-semibold text-emerald-400">当日有效</span>
                                      </p>
                                  </div>
                                  <div className="mt-2">
                                      {menuItems.map((item) => (
                                          <button
                                              key={item.key}
                                              type="button"
                                              className={cn("flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-white/[0.07]", item.danger ? "text-zinc-400 hover:text-red-400" : "text-zinc-300 hover:text-white")}
                                              onClick={item.onClick}
                                          >
                                              {item.icon}
                                              <span>{item.label}</span>
                                          </button>
                                      ))}
                                  </div>
                              </div>
                          ) : (
                              <div className="w-[248px] rounded-2xl border border-white/10 bg-[#12151f]/[0.97] p-4 text-center shadow-[0_24px_70px_rgba(0,0,0,0.6)] backdrop-blur-xl">
                                  <p className="text-sm text-zinc-400">登录后可查看积分与账号信息</p>
                                  <button
                                      type="button"
                                      className="mt-3 w-full cursor-pointer rounded-full bg-gradient-to-r from-[#4e46e9] to-[#8979ff] py-2 text-sm font-semibold text-white transition hover:brightness-110"
                                      onClick={() => {
                                          setOpen(false);
                                          onLogin();
                                      }}
                                  >
                                      立即登录
                                  </button>
                              </div>
                          )}
                      </div>,
                      document.body,
                  )
                : null}
        </div>
    );
}
