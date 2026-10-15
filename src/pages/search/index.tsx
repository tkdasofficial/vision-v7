import WorkspaceSearch from "@/components/workspace-search";
import { useState } from "react";
import { useLocation, useNavigate } from "@/lib/router-compat";
import { safeReturnPath } from "@/lib/route-access";

/** Search is its own page: it opens directly (swipe down or the drawer's Search button), never through the App Drawer. */
export default function Search({ library = false }: { library?: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const candidate = safeReturnPath(new URLSearchParams(location.searchStr).get("returnTo"));
  const returnTo = library ? "/drawer" : candidate.startsWith("/search") ? "/chat" : candidate;
  return <div className="app-drawer drawer-pane-in flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-background text-foreground" data-scrolled={scrolled}><WorkspaceSearch library={library} topSearch onBack={() => navigate(returnTo)} onScrollChange={setScrolled} /></div>;
}
