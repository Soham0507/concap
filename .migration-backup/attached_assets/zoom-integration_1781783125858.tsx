import StaticPageLayout from "@/components/StaticPageLayout";
import { Link2, Shield, FileText, Trash2, Mail } from "lucide-react";

export default function ZoomIntegrationPage() {
  return (
    <StaticPageLayout title="Zoom Integration Guide">
      <div className="text-center mb-12">
        <span className="inline-block px-3 py-1 rounded-full bg-blue-50 text-blue-700 text-sm font-medium mb-4">Integration</span>
        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-2">Zoom Integration Guide</h1>
        <p className="text-gray-500 mt-2">Connect your Zoom account to import meetings and transcripts.</p>
      </div>

      <div className="space-y-10 text-gray-700 leading-relaxed">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Link2 className="h-5 w-5 text-blue-500" />
            <h2 className="text-xl font-semibold text-gray-900">Connect Zoom</h2>
          </div>
          <ol className="list-decimal pl-6 space-y-2">
            <li>Go to <strong>Settings → Integrations</strong></li>
            <li>Click <strong>Connect Zoom</strong></li>
            <li>Authorize Requisor to access your Zoom account</li>
          </ol>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <FileText className="h-5 w-5 text-blue-500" />
            <h2 className="text-xl font-semibold text-gray-900">Data Accessed</h2>
          </div>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Meeting transcripts</strong> — cloud recording transcripts from your Zoom meetings</li>
            <li><strong>Meeting metadata</strong> — title, date/time, and participant information</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900 mb-3">How We Use Your Data</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Extract customer insights and product feedback</li>
            <li>Generate PRDs, feature specs, and execution plans</li>
            <li>Create execution-ready outputs for your development team</li>
          </ul>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <Shield className="h-5 w-5 text-blue-500" />
            <h2 className="text-xl font-semibold text-gray-900">Security</h2>
          </div>
          <ul className="list-disc pl-6 space-y-2">
            <li>All data is encrypted in transit (TLS 1.2+) and at rest (AES-256)</li>
            <li>Workspace-level isolation ensures your data is never shared with other accounts</li>
            <li>OAuth-based authorization — we never store your Zoom password</li>
          </ul>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <Link2 className="h-5 w-5 text-orange-500" />
            <h2 className="text-xl font-semibold text-gray-900">Disconnect Zoom</h2>
          </div>
          <p>
            To disconnect your Zoom account, go to <strong>Settings → Integrations → Disconnect Zoom</strong>.
            This will revoke Requisor's access to your Zoom data.
          </p>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <Trash2 className="h-5 w-5 text-red-500" />
            <h2 className="text-xl font-semibold text-gray-900">Delete Your Data</h2>
          </div>
          <p>
            You can delete individual meeting data from within the platform, or request
            full deletion of all your Zoom-related data by contacting our support team.
          </p>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-3">
            <Mail className="h-5 w-5 text-teal-500" />
            <h2 className="text-xl font-semibold text-gray-900">Support</h2>
          </div>
          <p>
            Need help with the Zoom integration? Contact us at{" "}
            <a href="mailto:support@requisor.io" className="text-teal-600 hover:text-teal-700 font-medium">
              support@requisor.io
            </a>
          </p>
        </section>
      </div>
    </StaticPageLayout>
  );
}
