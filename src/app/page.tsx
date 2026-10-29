import AppShell from "@/components/AppShell";
import { getStory, listStories, listStoryMetas } from "@/lib/stories";
import { loadDashboardTrends } from "@/lib/trends";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ story?: string | string[] }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.story) ? params.story[0] : params.story;
  const [story, stories, metas, trends] = await Promise.all([
    requested ? getStory(requested) : null,
    listStories(),
    listStoryMetas(),
    loadDashboardTrends(),
  ]);
  return (
    <AppShell initialStory={story} stories={stories} metas={metas} trends={trends} />
  );
}
