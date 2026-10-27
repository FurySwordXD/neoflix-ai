import Dashboard from "@/components/Dashboard";
import StoryMapApp from "@/components/StoryMapApp";
import { getStory, listStories, listStoryMetas } from "@/lib/stories";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ story?: string | string[] }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.story) ? params.story[0] : params.story;
  const stories = listStories();

  if (requested) {
    const story = getStory(requested);
    if (story) return <StoryMapApp initialStory={story} stories={stories} />;
  }

  return <Dashboard metas={listStoryMetas()} />;
}
