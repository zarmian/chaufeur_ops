-- CreateTable
CREATE TABLE "ClientFavouriteLocation" (
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientFavouriteLocation_pkey" PRIMARY KEY ("clientId","locationId")
);

-- CreateIndex
CREATE INDEX "ClientFavouriteLocation_locationId_idx" ON "ClientFavouriteLocation"("locationId");

-- AddForeignKey
ALTER TABLE "ClientFavouriteLocation" ADD CONSTRAINT "ClientFavouriteLocation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientFavouriteLocation" ADD CONSTRAINT "ClientFavouriteLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

