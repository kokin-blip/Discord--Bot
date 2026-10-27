import { readFileSync } from 'node:fs';
import { replayNews } from '../src/research/news-replay.js';
import { syntheticNewsReplay } from '../src/research/news-fixtures.js';
try {
  const path = process.argv[2];
  if (path === '--help')
    console.log(
      'Usage: npm run news:replay -- [licensed-fixture.json]\nWithout a file, replay synthetic fixtures offline. Never sends Discord messages.',
    );
  else
    console.log(
      JSON.stringify(
        replayNews(path ? JSON.parse(readFileSync(path, 'utf8')) : syntheticNewsReplay()),
        null,
        2,
      ),
    );
} catch {
  console.error(
    'NEWS_REPLAY_FAILED: invalid input or persistence failure; raw source errors suppressed.',
  );
  process.exitCode = 1;
}
