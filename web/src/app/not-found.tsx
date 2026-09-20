import { redirect } from "next/navigation";

/** 任意未匹配路由一律回到首页（历史遗留地址如旧品牌图片路径也由此兜底）。 */
export default function NotFound() {
    redirect("/");
}
