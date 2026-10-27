import AppShell from "@/components/AppShell";
import { getStory, listStories, listStoryMetas } from "@/lib/stories";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ story?: string | string[] }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.story) ? params.story[0] : params.story;
  const story = requested ? getStory(requested) : null;
  return (
    <AppShell initialStory={story} stories={listStories()} metas={listStoryMetas()} />
  );
}
