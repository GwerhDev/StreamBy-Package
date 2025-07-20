-- CreateTable
CREATE TABLE "streamby"."Project" (
    "id" TEXT NOT NULL,
    "dbType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image" TEXT,
    "allowUpload" BOOLEAN NOT NULL DEFAULT true,
    "allowSharing" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streamby"."FolderNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "FolderNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streamby"."Member" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streamby"."Export" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "collectionName" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streamby"."ExportCollection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExportCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streamby"."ExportEntry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "exportCollectionId" TEXT NOT NULL,

    CONSTRAINT "ExportEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExportCollection_projectId_name_key" ON "streamby"."ExportCollection"("projectId", "name");

-- AddForeignKey
ALTER TABLE "streamby"."FolderNode" ADD CONSTRAINT "FolderNode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "streamby"."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streamby"."FolderNode" ADD CONSTRAINT "FolderNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "streamby"."FolderNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streamby"."Member" ADD CONSTRAINT "Member_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "streamby"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streamby"."Export" ADD CONSTRAINT "Export_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "streamby"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streamby"."ExportCollection" ADD CONSTRAINT "ExportCollection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "streamby"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streamby"."ExportEntry" ADD CONSTRAINT "ExportEntry_exportCollectionId_fkey" FOREIGN KEY ("exportCollectionId") REFERENCES "streamby"."ExportCollection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
