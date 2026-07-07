import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_NOTEBOOK_EDITOR_SETTINGS,
  getNotebookEditorSettingsSnapshot,
  setNotebookEditorSettings,
} from "@/components/editor/editor-settings-store";
import { useSyncedSettings, useSyncedTheme } from "../useSyncedSettings";

const mocks = vi.hoisted(() => {
  const getSynced = vi.fn();
  const onChanged = vi.fn();
  const rotateInstallId = vi.fn();
  const setNativeTheme = vi.fn();
  const setSynced = vi.fn();
  const unlisten = vi.fn();
  return {
    getSynced,
    host: {
      settings: {
        getSynced,
        onChanged,
        rotateInstallId,
        setSynced,
      },
      window: {
        setTheme: setNativeTheme,
      },
    },
    onChanged,
    rotateInstallId,
    setNativeTheme,
    setSynced,
    unlisten,
  };
});

vi.mock("@nteract/notebook-host", () => ({
  useNotebookHost: () => mocks.host,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSyncedSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.getSynced.mockReset();
    mocks.onChanged.mockReset();
    mocks.rotateInstallId.mockReset();
    mocks.setNativeTheme.mockReset();
    mocks.setSynced.mockReset();
    mocks.unlisten.mockReset();
    mocks.getSynced.mockResolvedValue({});
    mocks.onChanged.mockReturnValue(mocks.unlisten);
    mocks.rotateInstallId.mockResolvedValue("install-2");
    mocks.setNativeTheme.mockResolvedValue(undefined);
    mocks.setSynced.mockResolvedValue(undefined);
    setNotebookEditorSettings(DEFAULT_NOTEBOOK_EDITOR_SETTINGS);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("ignores initial host settings that resolve after unmount", async () => {
    const load = deferred<unknown>();
    mocks.getSynced.mockReturnValue(load.promise);

    const { unmount } = renderHook(() => useSyncedSettings());

    await waitFor(() => {
      expect(mocks.getSynced).toHaveBeenCalled();
    });

    unmount();

    await act(async () => {
      load.resolve({ color_theme: "cream", theme: "dark" });
      await load.promise;
    });

    expect(localStorage.getItem("notebook-theme")).toBeNull();
    expect(localStorage.getItem("notebook-color-theme")).toBeNull();
  });

  it("ignores settings events after unmount", async () => {
    let handler: ((settings: unknown) => void) | undefined;
    mocks.onChanged.mockImplementation((eventHandler: (settings: unknown) => void) => {
      handler = eventHandler;
      return mocks.unlisten;
    });

    const { unmount } = renderHook(() => useSyncedSettings());

    await waitFor(() => {
      expect(mocks.onChanged).toHaveBeenCalledWith(expect.any(Function));
    });

    unmount();

    act(() => {
      handler?.({ color_theme: "cream", theme: "dark" });
    });

    expect(localStorage.getItem("notebook-theme")).toBeNull();
    expect(localStorage.getItem("notebook-color-theme")).toBeNull();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("persists setting writes through the host settings namespace", async () => {
    const { result } = renderHook(() => useSyncedSettings());

    await act(async () => {
      result.current.setTheme("dark");
      result.current.setColorTheme("cream");
      await result.current.rotateInstallId();
    });

    expect(mocks.setSynced).toHaveBeenCalledWith("theme", "dark");
    expect(mocks.setSynced).toHaveBeenCalledWith("color_theme", "cream");
    expect(mocks.rotateInstallId).toHaveBeenCalledTimes(1);
    expect(result.current.installId).toBe("install-2");
  });

  it("projects and persists editor settings through the host settings namespace", async () => {
    mocks.getSynced.mockResolvedValue({
      editor: {
        code_font_family: '"Hack", monospace',
        markdown_font_family: "Georgia, serif",
        line_numbers: true,
      },
    });

    const { result } = renderHook(() => useSyncedSettings());

    await waitFor(() => {
      expect(getNotebookEditorSettingsSnapshot()).toEqual({
        codeFontFamily: '"Hack", monospace',
        markdownFontFamily: "Georgia, serif",
        lineNumbers: true,
      });
    });

    await act(async () => {
      result.current.setEditorCodeFontFamily('"Fira Code", monospace');
      result.current.setEditorMarkdownFontFamily("");
      result.current.setEditorLineNumbers(false);
    });

    expect(mocks.setSynced).toHaveBeenCalledWith(
      "editor.code_font_family",
      '"Fira Code", monospace',
    );
    expect(mocks.setSynced).toHaveBeenCalledWith("editor.markdown_font_family", "");
    expect(mocks.setSynced).toHaveBeenCalledWith("editor.line_numbers", false);
    expect(getNotebookEditorSettingsSnapshot()).toEqual({
      codeFontFamily: '"Fira Code", monospace',
      markdownFontFamily: "",
      lineNumbers: false,
    });
  });
});

describe("useSyncedTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.getSynced.mockReset();
    mocks.onChanged.mockReset();
    mocks.rotateInstallId.mockReset();
    mocks.setNativeTheme.mockReset();
    mocks.setSynced.mockReset();
    mocks.unlisten.mockReset();
    mocks.getSynced.mockResolvedValue({});
    mocks.onChanged.mockReturnValue(mocks.unlisten);
    mocks.setNativeTheme.mockResolvedValue(undefined);
    mocks.setSynced.mockResolvedValue(undefined);
    setNotebookEditorSettings(DEFAULT_NOTEBOOK_EDITOR_SETTINGS);

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    localStorage.clear();
    delete (window as Partial<Window>).matchMedia;
  });

  it("syncs native window theme through the host window namespace", async () => {
    const { result } = renderHook(() => useSyncedTheme());

    await waitFor(() => {
      expect(mocks.setNativeTheme).toHaveBeenCalledWith(null);
    });
    mocks.setNativeTheme.mockClear();

    await act(async () => {
      result.current.setTheme("dark");
    });

    await waitFor(() => {
      expect(mocks.setNativeTheme).toHaveBeenCalledWith("dark");
    });
  });
});
