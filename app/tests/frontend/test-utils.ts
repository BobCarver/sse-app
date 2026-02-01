// test/test-utils.ts
// Lightweight DOM shims to make `deno-dom` behave closer to browser
// collections used in tests (table.rows, tr.cells).
// deno-lint-ignore-file no-explicit-any

export const applyTableShims = (doc: any) => {
  const makeCollection = (elems: Element[]) => {
    const arr = elems;
    const col: any = { length: arr.length };
    arr.forEach((el, i) => (col[i] = el));
    col.item = (i: number) => arr[i];
    (col as any)[Symbol.iterator] = function* () {
      for (const e of arr) yield e;
    };
    return col;
  };

  const attachCellsToRow = (tr: any) => {
    if (!("cells" in tr)) {
      Object.defineProperty(tr, "cells", {
        get: function () {
          const tds = Array.from((this as Element).querySelectorAll("td,th"));
          return makeCollection(tds);
        },
        configurable: true,
      });
    }
  };

  const attachRowsTo = (el: any) => {
    if (!("rows" in el)) {
      Object.defineProperty(el, "rows", {
        get: function () {
          const trs = Array.from((this as Element).querySelectorAll("tr"));
          trs.forEach(attachCellsToRow);
          return makeCollection(trs) as unknown as HTMLCollectionOf<
            HTMLTableRowElement
          >;
        },
        configurable: true,
      });
    }
  };

  const tables = Array.from(doc.querySelectorAll("table, tbody, thead, tfoot"));
  (tables as any).forEach(attachRowsTo);
};

export const applyStyleShim = (doc: any, selector: string = "#tbody") => {
  const els = Array.from(doc.querySelectorAll(selector));
  els.forEach((el: any) => {
    if (!("style" in el)) {
      (el as any).style = {
        _props: {} as Record<string, string>,
        setProperty(key: string, value: string) {
          this._props[key] = value;
        },
        getPropertyValue(key: string) {
          return this._props[key] || "";
        },
      };
    }
  });
};
