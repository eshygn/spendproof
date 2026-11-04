import { App } from "@/components/App";
import { snapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page() {
  const initial = await snapshot();
  return <App initial={initial} />;
}
