import { redirect } from "next/navigation";

export default function ImageWorkbenchPage() {
    redirect("/create?mode=image");
}
