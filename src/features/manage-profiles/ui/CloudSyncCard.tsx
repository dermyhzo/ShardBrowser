import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button, SegmentControl, Select } from "@proxyshard/shardx-ui-kit";
import { DownloadIcon, FolderIcon, RefreshIcon, UploadIcon } from "../../../shared/icons";
import { toast } from "../../../shared/model/toast";
import { confirmModal } from "../../../shared/lib/confirm";
import { useT } from "../../../shared/i18n";
import {
  cloudSyncStatus, cloudSyncSetTarget, cloudSyncPush, cloudSyncPull,
  type CloudSyncTarget,
} from "../../../entities/settings";
import { profileList, type ProfileMeta } from "../../../entities/profile";

const ALL = "__all__";

/** Back profiles up to a NAS or Google Drive folder and restore them. The
 *  backend copies snapshots and refuses running profiles. */
export function CloudSyncCard() {
  const t = useT();
  const [targets, setTargets] = useState<CloudSyncTarget[]>([]);
  const [sel, setSel] = useState<"nas" | "gdrive">("gdrive");
  const [local, setLocal] = useState<ProfileMeta[]>([]);
  const [profile, setProfile] = useState(ALL);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => {
    cloudSyncStatus().then(setTargets).catch(() => {});
    profileList().then(setLocal).catch(() => {});
  };
  useEffect(refresh, []);

  const cur = targets.find((x) => x.name === sel);
  const ready = !!cur?.dir && cur.reachable;
  const label = (n: string) => (n === "nas" ? t("cloudSync.nas") : t("cloudSync.gdrive"));

  const pick = async () => {
    const dir = await open({ directory: true, title: t("cloudSync.pickFolderTitle") });
    if (typeof dir !== "string") return;
    // A dedicated subfolder keeps the backup from mixing with the user's files.
    const target = /ShardX-Sync[\\/]?$/.test(dir) ? dir : `${dir.replace(/[\\/]+$/, "")}/ShardX-Sync`;
    try { await cloudSyncSetTarget(sel, target); refresh(); }
    catch (e) { toast.err(String(e)); }
  };
  const reset = async () => {
    try { await cloudSyncSetTarget(sel, ""); refresh(); }
    catch (e) { toast.err(String(e)); }
  };

  /** `key` names the button that spins: "main" or the row's profile id. */
  const run = async (kind: "push" | "pull", ids: string[] | undefined, key: string) => {
    if (kind === "pull") {
      const ok = await confirmModal({
        title: t("cloudSync.pullConfirmTitle"),
        message: ids ? t("cloudSync.pullConfirmOne") : t("cloudSync.pullConfirmAll"),
        buttons: [
          { label: t("cloudSync.cancel"), value: false },
          { label: t("cloudSync.pullAction"), value: true, primary: true },
        ],
      });
      if (ok !== true) return;
    }
    setBusy(`${kind}:${key}`);
    try {
      const r = await (kind === "push" ? cloudSyncPush : cloudSyncPull)(sel, ids);
      const vars = { n: r.profiles, files: r.files_copied, target: label(sel) };
      toast.ok(kind === "push" ? t("cloudSync.pushedOk", vars) : t("cloudSync.pulledOk", vars));
    } catch (e) {
      toast.err(String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const ids = profile === ALL ? undefined : [profile];

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-paragraph-xs text-text-soft-400">{t("cloudSync.intro")}</p>

      <SegmentControl
        size="small"
        value={sel}
        onChange={(v) => setSel(v as "nas" | "gdrive")}
        items={[
          { value: "gdrive", label: t("cloudSync.gdrive") },
          { value: "nas", label: t("cloudSync.nas") },
        ]}
      />

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-label-xs text-text-sub-600">
          {t("cloudSync.folder")}
          <span className={`inline-flex items-center gap-1 ${ready ? "text-success-base" : "text-warning-base"}`}>
            <span className={`size-1.5 rounded-full ${ready ? "bg-success-base" : "bg-warning-base"}`} />
            {!cur?.dir ? t("cloudSync.notSet") : cur.reachable ? t("cloudSync.connected") : t("cloudSync.unreachable")}
          </span>
        </span>
        <div className="flex items-center gap-2">
          <span className="mono min-w-0 flex-1 truncate rounded-8 bg-bg-weak-50 px-[11px] py-[9px] text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
            {cur?.dir ?? (sel === "nas" ? t("cloudSync.nasHint") : t("cloudSync.gdriveHint"))}
          </span>
          {cur?.dir && cur.reachable && (
            <Button variant="neutral" mode="stroke" size="small"
              onClick={() => openPath(cur.dir!).catch(() => toast.err(t("cloudSync.openFailed")))}>
              {t("cloudSync.reveal")}
            </Button>
          )}
          {cur?.custom && (
            <Button variant="neutral" mode="stroke" size="small" onClick={reset}>
              {t("cloudSync.useDefault")}
            </Button>
          )}
          <Button variant="primary" mode="stroke" size="small"
            leftIcon={<FolderIcon className="size-4" />} onClick={pick}>
            {t("cloudSync.change")}
          </Button>
        </div>
        {cur?.last_push && (
          <span className="text-paragraph-xs text-text-soft-400">
            {t("cloudSync.lastPush", { when: new Date(cur.last_push.at).toLocaleString(), host: cur.last_push.host })}
          </span>
        )}
      </label>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <Select
            label={t("cloudSync.profileLabel")}
            size="small"
            value={profile}
            onChange={setProfile}
            options={[
              { value: ALL, label: t("cloudSync.allProfiles") },
              ...local.map((p) => ({ value: p.id, label: p.name || p.id })),
            ]}
          />
        </div>
        <Button variant="primary" mode="filled" size="small" disabled={!ready || !!busy}
          isLoading={busy === "push:main"} leftIcon={<UploadIcon className="size-4" />}
          onClick={() => run("push", ids, "main")}>
          {t("cloudSync.push", { target: label(sel) })}
        </Button>
        <Button variant="neutral" mode="stroke" size="small" disabled={!ready || !!busy}
          isLoading={busy === "pull:main"} leftIcon={<DownloadIcon className="size-4" />}
          onClick={() => run("pull", ids, "main")}>
          {t("cloudSync.pull")}
        </Button>
        <Button variant="neutral" mode="ghost" size="small" leftIcon={<RefreshIcon className="size-4" />}
          onClick={refresh} aria-label={t("cloudSync.refresh")} />
      </div>

      {ready && (
        <div className="flex flex-col rounded-8 ring-1 ring-inset ring-stroke-soft-200">
          <div className="border-b border-stroke-soft-200 px-3 py-2 text-label-xs text-text-sub-600">
            {t("cloudSync.storedTitle", { n: cur!.profiles.length, target: label(sel) })}
          </div>
          {cur!.profiles.length === 0 ? (
            <div className="px-3 py-3 text-paragraph-xs text-text-soft-400">{t("cloudSync.storedEmpty")}</div>
          ) : (
            cur!.profiles.map((p) => {
              const here = local.some((l) => l.id === p.id);
              return (
                <div key={p.id} className="flex items-center gap-2 border-b border-stroke-soft-200 px-3 py-1.5 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-paragraph-xs text-text-strong-950">
                    {p.name || p.id}
                    <span className="mono ml-2 text-text-soft-400">{p.id.slice(0, 8)}</span>
                  </span>
                  <span className="text-paragraph-xs text-text-soft-400">
                    {here ? t("cloudSync.alsoLocal") : t("cloudSync.onlyRemote")}
                  </span>
                  <Button variant="neutral" mode="stroke" size="xsmall" disabled={!!busy}
                    isLoading={busy === `pull:${p.id}`} onClick={() => run("pull", [p.id], p.id)}>
                    {t("cloudSync.restore")}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      )}

      <p className="m-0 text-paragraph-xs text-text-soft-400">{t("cloudSync.footnote")}</p>
    </div>
  );
}
