import { registerGame } from "@zgame/game-sdk";
import { snakeManifest } from "./manifest.js";
import { createSnakeGame } from "./game.js";

export { snakeManifest } from "./manifest.js";
export * from "./game.js";

registerGame({
  manifest: snakeManifest,
  create: createSnakeGame,
});
