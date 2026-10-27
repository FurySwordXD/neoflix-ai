import StoryMapApp from "@/components/StoryMapApp";
import { getStory, listStories } from "@/lib/stories";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ story?: string | string[] }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.story) ? params.story[0] : params.story;
  const stories = listStories();
  const story =
    (requested ? getStory(requested) : null) ??
    getStory("covid-19-pandemic") ??
    (stories[0] ? getStory(stories[0].slug) : null);

  if (!story) {
    return (
      <main className="flex h-screen items-center justify-center">
        <p className="text-slate-400">
          No story found. Add one under <code>src/data/stories/&lt;slug&gt;/meta.json</code>.
        </p>
      </main>
    );
  }

  return <StoryMapApp initialStory={story} stories={stories} />;
}
