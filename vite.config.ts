import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // contracts/lib/* submodules (Uniswap, OpenZeppelin) carry their own
  // Hardhat/Mocha test suites, which vitest's default glob would otherwise
  // pick up and fail on missing devDependencies that belong to their own
  // toolchain, not this project's.
  test: { exclude: ["node_modules/**", "dist/**", "contracts/lib/**"] },
});
