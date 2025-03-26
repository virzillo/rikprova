import React, { useState, useCallback, useEffect } from 'react';
import { 
  Page, 
  Card, 
  Select, 
  Button, 
  FormLayout,
  TextField,
  DropZone,
  Banner
} from '@shopify/polaris';
import { useActionData, useSubmit, useLoaderData } from "@remix-run/react";
import type { action, loader } from "./app.compara.server";
import * as XLSX from 'xlsx';

export default function AppCompara() {
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const submit = useSubmit();
  
  const [file, setFile] = useState<File | null>(null);
  const [excelColumns, setExcelColumns] = useState<string[]>([]);
  const [selectedExcelColumn, setSelectedExcelColumn] = useState<string>('');
  const [selectedFornitoreValue, setSelectedFornitoreValue] = useState<string>('');
  const [tagValue, setTagValue] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('draft');
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [feedbackType, setFeedbackType] = useState<'success' | 'error' | null>(null);

  const handleFileDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[]) => {
      const uploadedFile = acceptedFiles[0];
      setFile(uploadedFile);

      if (uploadedFile) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const workbook = XLSX.read(e.target?.result, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const data = XLSX.utils.sheet_to_json(worksheet);
          
          if (data.length > 0) {
            setExcelColumns(Object.keys(data[0] as Record<string, any>));
          } else {
            console.error('No data found in the Excel file');
          }
        };
        reader.onerror = (error) => {
          console.error('Error reading file:', error);
        };
        reader.readAsBinaryString(uploadedFile);
      } else {
        console.error('No file uploaded');
      }
    },
    []
  );

  const handleSubmit = () => {
    if (file && selectedExcelColumn && selectedFornitoreValue && tagValue) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("excelColumn", selectedExcelColumn);
      formData.append("fornitoreValue", selectedFornitoreValue);
      formData.append("tag", tagValue);
      formData.append("status", selectedStatus);
      submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  };

  useEffect(() => {
    if (actionData) {
      if (actionData.error) {
        setFeedbackMessage(actionData.error);
        setFeedbackType('error');
      } else if (actionData.success) {
        setFeedbackMessage(actionData.message);
        setFeedbackType('success');
      }
    }
  }, [actionData]);

  const statusOptions = [
    { label: "Draft", value: "draft" },
    { label: "Active", value: "active" },
    { label: "Archived", value: "archived" },
  ];

  if (!loaderData) {
    return <Banner tone="critical">Failed to load data</Banner>;
  }

  const { fornitoreValues, rawData } = loaderData as { fornitoreValues: string[]; rawData: any };

  return (
    <Page title="Product Matching Tool">
      <Card>
        <FormLayout>
          <DropZone 
            onDrop={handleFileDrop} 
            accept=".xlsx, .xls"
            allowMultiple={false}
          >
            <DropZone.FileUpload />
          </DropZone>
          
          {file && <p>Selected file: {file.name}</p>}

          {excelColumns.length > 0 ? (
            <Select
              label="Select Excel Column to Match"
              placeholder="Choose a column"
              options={excelColumns.map(col => ({ 
                label: col, 
                value: col 
              }))}
              value={selectedExcelColumn}
              onChange={(value) => setSelectedExcelColumn(value)}
            />
          ) : (
            <Banner tone="warning">
              <p>No columns found in the uploaded Excel file</p>
            </Banner>
          )}

          {Array.isArray(fornitoreValues) ? (
            <Select
              label="Select Fornitore Value"
              placeholder="Choose a Fornitore"
              options={fornitoreValues.map((value: string) => ({
                label: value,
                value: value
              }))}
              value={selectedFornitoreValue}
              onChange={(value) => setSelectedFornitoreValue(value)}
            />
          ) : (
            <Banner tone="warning">
              <p>Failed to load Fornitore values</p>
            </Banner>
          )}

          <TextField
            label="Tag to Add"
            value={tagValue}
            onChange={(value) => setTagValue(value)}
            placeholder="Enter a tag for matched products"
            autoComplete="off"
          />

          <Select
            label="Product Status"
            options={statusOptions}
            value={selectedStatus}
            onChange={(value) => setSelectedStatus(value)}
          />

          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!file || !selectedExcelColumn || !selectedFornitoreValue || !tagValue}
          >
            {!file ? "Upload File First" : 
             !selectedExcelColumn ? "Select Excel Column" : 
             !selectedFornitoreValue ? "Select Fornitore" : 
             !tagValue ? "Enter a Tag" : 
             "Process Products"}
          </Button>

          {feedbackMessage && (
            <Banner
              title={feedbackMessage}
              tone={feedbackType === 'success' ? 'success' : 'critical'}
            />
          )}

          <Card>
            <h2>Raw Data</h2>
            <pre>{JSON.stringify(rawData, null, 2)}</pre>
          </Card>
        </FormLayout>
      </Card>
    </Page>
  );
}