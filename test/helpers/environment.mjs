import path from "node:path";

/** A test child gets an allowlist, never the developer's credentials/profiles. */
export function isolatedEnvironment(parent, state, port, upstream) {
  const system = Object.fromEntries([
    "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL", "TZ",
  ].filter(name => typeof parent[name] === "string").map(name => [name, parent[name]]));
  const profile = path.join(state, "profile");
  const temporary = path.join(state, "temp");
  return {
    ...system,
    HOME: profile, USERPROFILE: profile,
    APPDATA: path.join(state, "appdata"), LOCALAPPDATA: path.join(state, "localappdata"),
    XDG_CONFIG_HOME: path.join(state, "config"), XDG_DATA_HOME: path.join(state, "data"),
    XDG_CACHE_HOME: path.join(state, "cache"),
    PATH: path.join(state, "bin"), TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    // Magpie gates account-bearing provider plugins here; this profile is fake.
    MAGPIE_NO_ACCOUNTS: "0", DO_NOT_TRACK: "1", MAGPIE_NO_STATS: "1",
    MAGPIE_ADDR: "127.0.0.1:" + port, MAGPIE_UNCLOAK_TEST_UPSTREAM: upstream,
  };
}
