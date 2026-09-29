import { parseManifest, type GameManifest } from "@zgame/protocol";
import raw from "../manifest.json" with { type: "json" };

const parsed = parseManifest(raw);
if (!parsed) throw new Error("invalid snake manifest");

export const snakeManifest: GameManifest = parsed;
export default snakeManifest;
