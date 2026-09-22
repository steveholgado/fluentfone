import type { RequirementResult } from '#/lib/device';
import { Notification } from '#/components/Notification';

interface UnsupportedScreenProps {
  visible: boolean;
  status: string;
  unmet: RequirementResult[];
}

export function UnsupportedScreen({
  visible,
  status,
  unmet,
}: UnsupportedScreenProps) {
  return (
    <Notification visible={visible}>
      <div className="text-lg">{status}</div>
      <div>
        Unfortunately your device needs the following features in order to run
        this app:
      </div>
      <ul className="ms-6 list-disc">
        {unmet.map((requirement) => (
          <li key={requirement.id}>{requirement.label}</li>
        ))}
      </ul>
    </Notification>
  );
}
