import { useEffect, useState } from "react";
import { api } from "../../api";

/*
==================================================
ADMIN TRUNKS SECTION — NEW, per explicit request
==================================================
Fills in the "DID / Trunk Setup" placeholder that's sat in AdminPage.jsx
since Campaigns first went live. Lets an admin add/edit/remove an
outbound SIP trunk (e.g. another Telpeer extension, each pre-configured
on Telpeer's own portal with a different Caller ID) directly through the
app — no more hand-writing pjsip.conf blocks over SSH every time one's
needed.

trunk_name is immutable once created (same reasoning as phone
extensions elsewhere in this app) — campaigns reference it directly via
their own Outbound Trunk setting, so renaming would silently orphan
anything already pointing at the old name. Password is optional on
edit — leave blank to keep the current one, same convention already
used for campaign audio uploads elsewhere in this app.

The built-in "CMXCallSuite" trunk (QuestBlue, hand-maintained,
pre-existing) deliberately never appears here — this page only manages
trunks created THROUGH it.
==================================================
*/
export default function AdminTrunksSection() {
  const [trunks, setTrunks] = useState([]);
  const [editingTrunkId, setEditingTrunkId] = useState(null); // null = create mode

  const [trunkName, setTrunkName] = useState("");
  const [sipUsername, setSipUsername] = useState("");
  const [sipPassword, setSipPassword] = useState("");
  const [sipServer, setSipServer] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // Tracks whether the CURRENT success-state message is actually a
  // reloadWarning (DB saved fine, but applying to Asterisk failed) —
  // set explicitly at each call site below, rather than guessing from
  // the message text, so the render below can style it as .warning
  // (amber) instead of .success (green) without any string-sniffing.
  const [successIsWarning, setSuccessIsWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function loadTrunks() {
    setLoading(true);
    api
      .getTrunks()
      .then((data) => setTrunks(data.trunks || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load-on-mount is this component's whole data-fetch pattern, same as every other list/table in this app.
    loadTrunks();
  }, []);

  function resetForm() {
    setEditingTrunkId(null);
    setTrunkName("");
    setSipUsername("");
    setSipPassword("");
    setSipServer("");
    setDescription("");
    setActive(true);
    setError("");
    setSuccess("");
    setSuccessIsWarning(false);
  }

  function handleStartEdit(t) {
    setEditingTrunkId(t.trunk_id);
    setTrunkName(t.trunk_name);
    setSipUsername(t.sip_username || "");
    setSipPassword(""); // never pre-filled — blank means "keep current" on save
    setSipServer(t.sip_server || "");
    setDescription(t.description || "");
    setActive(t.active === 1 || t.active === true);
    setError("");
    setSuccess("");
    setSuccessIsWarning(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setSuccessIsWarning(false);
    setBusy(true);
    try {
      const payload = { sipUsername, sipPassword, sipServer, description, active };
      let result;
      if (editingTrunkId) {
        result = await api.updateTrunk(editingTrunkId, payload);
      } else {
        result = await api.createTrunk({ trunkName, ...payload });
      }
      // REAL BUG FIX: resetForm() itself calls setSuccess("") — calling
      // it AFTER setSuccess(result.reloadWarning || "Trunk saved.")
      // meant React's automatic batching collapsed both updates into
      // one render using resetForm's "" as the final value, so this
      // message (including any reloadWarning — e.g. "Trunk was saved,
      // but applying it to Asterisk failed") never actually rendered
      // at all. resetForm() must run FIRST so the real message set
      // afterward is what actually reaches the screen.
      resetForm();
      setSuccessIsWarning(Boolean(result.reloadWarning));
      setSuccess(result.reloadWarning || "Trunk saved.");
      loadTrunks();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(t) {
    if (!window.confirm(`Delete trunk "${t.trunk_name}"? This can't be undone.`)) return;
    setError("");
    setSuccess("");
    setSuccessIsWarning(false);
    setBusy(true);
    try {
      const result = await api.deleteTrunk(t.trunk_id);
      // Same fix as handleSubmit above — set AFTER any state that
      // clears success/error, never before.
      setSuccessIsWarning(Boolean(result.reloadWarning));
      setSuccess(result.reloadWarning || "Trunk deleted.");
      loadTrunks();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 style={{ marginTop: 0 }}>DID / Trunk Setup</h3>
      <p style={{ fontSize: 13, color: "#888" }}>
        The built-in QuestBlue trunk (CMXCallSuite) is hand-maintained and doesn't appear here.
        Add additional outbound trunks below — e.g. another Telpeer extension pre-configured with a
        different Caller ID on Telpeer's own portal.
      </p>

      {error && <div className="error">{error}</div>}
      {/* REAL BUG FIX (see handleSubmit/handleDelete above) — a
          reloadWarning ("saved, but Asterisk wasn't updated") now
          renders in the same amber .warning styling used elsewhere,
          not blended into the identical-looking green .success box a
          plain "Trunk saved." gets. Both are real outcomes worth
          telling apart at a glance, not just in the text. */}
      {success && <div className={successIsWarning ? "warning" : "success"}>{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="live-status-grid">
          <div>
            <form onSubmit={handleSubmit}>
              <div className="card">
                <h4 style={{ marginTop: 0 }}>{editingTrunkId ? `Edit "${trunkName}"` : "Add a Trunk"}</h4>

                {!editingTrunkId && (
                  <>
                    <label className="comments-label">Trunk Name</label>
                    <input
                      type="text"
                      value={trunkName}
                      onChange={(e) => setTrunkName(e.target.value)}
                      placeholder="Letters, numbers, and dashes only"
                      required
                    />
                  </>
                )}

                <label className="comments-label">SIP Username / Extension</label>
                <input type="text" value={sipUsername} onChange={(e) => setSipUsername(e.target.value)} required />

                <label className="comments-label">SIP Password</label>
                <input
                  type="password"
                  value={sipPassword}
                  onChange={(e) => setSipPassword(e.target.value)}
                  placeholder={editingTrunkId ? "Leave blank to keep the current password" : ""}
                  required={!editingTrunkId}
                />

                <label className="comments-label">SIP Server</label>
                <input
                  type="text"
                  value={sipServer}
                  onChange={(e) => setSipServer(e.target.value)}
                  placeholder="e.g. sip.carrier.com"
                  required
                />

                <label className="comments-label">Description (optional)</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Sales line spoofing"
                />

                {editingTrunkId && (
                  <label className="disposition-row" style={{ marginTop: 10 }}>
                    <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                    Active
                  </label>
                )}

                <div style={{ marginTop: 16 }}>
                  <button className="button-secondary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : editingTrunkId ? "Save Changes" : "Add Trunk"}
                  </button>{" "}
                  {editingTrunkId && (
                    <button type="button" className="link" onClick={resetForm} disabled={busy}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>

          <div>
            <div className="card call-log-card">
              <h4 style={{ marginTop: 0 }}>Existing Trunks</h4>
              {trunks.length === 0 ? (
                <p>No trunks added yet.</p>
              ) : (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Username</th>
                      <th>Server</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trunks.map((t) => (
                      <tr key={t.trunk_id} className="call-log-row" onDoubleClick={() => handleStartEdit(t)}>
                        <td>{t.trunk_name}</td>
                        <td>{t.sip_username}</td>
                        <td>{t.sip_server}</td>
                        <td>{t.active ? "Yes" : "No"}</td>
                        <td>
                          <button type="button" className="link" onClick={() => handleStartEdit(t)} disabled={busy}>
                            Edit
                          </button>{" "}
                          <button type="button" className="link" onClick={() => handleDelete(t)} disabled={busy}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
