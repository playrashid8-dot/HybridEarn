"use client";

export default function AdminPagination({ page, pageSize, total, onPageChange }) {
  const totalPages = Math.max(1, Math.ceil(Math.max(total, 1) / pageSize));
  const safePage = Math.min(page, totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);

  return (
    <div className="flex flex-col gap-3 border-t border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-gray-400 sm:flex-row sm:items-center sm:justify-between">
      <p>
        {total === 0 ? (
          "No entries"
        ) : (
          <>
            Showing <span className="text-gray-200">{from}</span>–
            <span className="text-gray-200">{to}</span> of{" "}
            <span className="text-gray-200">{total}</span>
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-gray-200 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-white/10"
        >
          Previous
        </button>
        <span className="tabular-nums text-gray-300">
          {safePage} / {totalPages}
        </span>
        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-gray-200 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-white/10"
        >
          Next
        </button>
      </div>
    </div>
  );
}
