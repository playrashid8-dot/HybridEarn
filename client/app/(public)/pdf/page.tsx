import Image from "next/image";

const pages = [
  "/images/page1.jpeg",
  "/images/page2.jpeg",
  "/images/page3.jpeg",
  "/images/page4.jpeg",
  "/images/page5.jpeg",
  "/images/page6.jpeg",
  "/images/page7.jpeg",
  "/images/page8.jpeg",
  "/images/page9.jpeg",
];

export default function PdfViewer() {
  return (
    <div className="px-4 py-6 pb-10">

      {/* HEADER */}
      <div className="text-center mb-6">
        <h1 className="text-3xl font-bold tracking-wide">
          💎 Hybrid EARN PDF
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          Premium Investment Overview
        </p>
      </div>

      {/* SHARE BUTTON */}
      <div className="flex justify-center mb-6">
        <a
          href="https://wa.me/?text=https://hybridearn.com/pdf"
          target="_blank"
          className="bg-green-500 px-5 py-2 rounded-full text-sm font-semibold shadow-lg hover:bg-green-600 transition"
        >
          📲 Share on WhatsApp
        </a>
      </div>

      {/* PDF IMAGES */}
      <div className="flex flex-col gap-6 items-center">
        {pages.map((src, index) => (
          <div key={index} className="w-full max-w-md">
            <Image
              src={src}
              alt={`Page ${index + 1}`}
              width={800}
              height={1200}
              className="rounded-2xl shadow-[0_0_30px_rgba(255,215,0,0.25)] border border-yellow-500/20"
              priority={index === 0}
            />
          </div>
        ))}
      </div>

    </div>
  );
}