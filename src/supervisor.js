// Tek konteyner, iki süreç. Canlı deploy için.
//
// Anchor ayrı bir süreçtir ve sahnede GERÇEKTEN ölür (process.exit). Yerelde iki terminal
// bunu doğal olarak sağlar; konteynerde bunu supervisor sağlar:
//
//   · anchor  → child process. Öldüğünde YENİDEN BAŞLATILMAZ — ölüm kasıtlı.
//   · cüzdan  → child process. Çökerse yeniden başlar (kullanıcı arayüzü ayakta kalmalı).
//   · cüzdan "revive" mesajı gönderirse anchor yeniden fork edilir.
//
// Böylece "Öldür" düğmesi konteynerde de HTTP'nin gerçekten kesilmesi demektir;
// "Dirilt" ise yeni bir süreç. Sahnede yalan yok.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[supervisor]", ...a);

let anchor = null;
let wallet = null;
let shuttingDown = false;

function startAnchor() {
  if (anchor && anchor.exitCode === null) return;
  anchor = fork(join(here, "anchor", "server.js"), [], {
    env: { ...process.env, ANCHOR_PORT: process.env.ANCHOR_PORT || "4200" },
    stdio: "inherit",
  });
  log("anchor başladı, pid", anchor.pid);
  anchor.on("exit", (code) => {
    log(`anchor öldü (kod ${code}) — kasıtlı; diriltilene kadar ölü kalır`);
    anchor = null;
  });
}

function startWallet() {
  wallet = fork(join(here, "server.js"), [], {
    env: {
      ...process.env,
      PORT: process.env.PORT || "8080",
      HOST: process.env.HOST || "0.0.0.0",
      ANCHOR_URL: `http://127.0.0.1:${process.env.ANCHOR_PORT || "4200"}`,
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  log("cüzdan başladı, pid", wallet.pid);
  wallet.on("message", (m) => {
    if (m?.type === "revive") {
      log("revive istendi");
      startAnchor();
    }
  });
  wallet.on("exit", (code) => {
    if (shuttingDown) return;
    log(`cüzdan çöktü (kod ${code}) — 2 sn sonra yeniden`);
    setTimeout(startWallet, 2000);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    anchor?.kill();
    wallet?.kill();
    setTimeout(() => process.exit(0), 300);
  });
}

startAnchor();
setTimeout(startWallet, 800); // anchor'ın dinlemeye başlaması için küçük pay
